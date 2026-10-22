import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir, writeTree, fakeCtx, setAllMtimes} from './helpers.mjs';
import * as agents from '../skills/disk-cleanup/scripts/lib/collect/agents.mjs';
import * as heavy from '../skills/disk-cleanup/scripts/lib/collect/heavy.mjs';

test('Claude temp: old session folder safe, fresh one ask', async () => {
  const tmp = await tmpdir(); await writeTree(tmp, {'claude/old/a.txt': '1', 'claude/new/a.txt': '1'});
  const old = new Date(Date.now() - 3 * 86400000); await setAllMtimes(path.join(tmp, 'claude/old'), old);
  const rows = await agents.collect(fakeCtx({tmp, now: Date.now()}));
  assert.deepEqual(rows.map(r => [path.basename(r.path), r.tag]).sort(), [['new', 'ask'], ['old', 'safe']]);
  const oldRow = rows.find(r => r.tag === 'safe');
  assert.equal(oldRow.reason.key, 'reason.agent_old');
  assert.equal(oldRow.reason.params.days, 3);
  assert.equal(oldRow.group, 'agents');
  assert.deepEqual(oldRow.action, {type: 'rm', path: oldRow.path});
  assert.equal(rows.find(r => r.tag === 'ask').reason.key, 'reason.agent_busy');
});
test('Claude temp: old folder with a busy dir inside is ask', async () => {
  const tmp = await tmpdir(); await writeTree(tmp, {'claude/old/sub/a.txt': '1', 'claude/other/a.txt': '1'});
  const old = new Date(Date.now() - 3 * 86400000);
  await setAllMtimes(path.join(tmp, 'claude/old'), old); await setAllMtimes(path.join(tmp, 'claude/other'), old);
  const busy = [path.join(tmp, 'claude/old/sub')];
  const rows = await agents.collect(fakeCtx({tmp, busy}));
  assert.deepEqual(rows.map(r => [path.basename(r.path), r.tag]).sort(), [['old', 'ask'], ['other', 'safe']]);
});
test('Claude temp: an incomplete scan is ask', async () => {
  const tmp = await tmpdir(); await writeTree(tmp, {'claude/big/a.txt': '1', 'claude/big/b.txt': '1'});
  const old = new Date(Date.now() - 3 * 86400000); await setAllMtimes(path.join(tmp, 'claude/big'), old);
  const [row] = await agents.collect(fakeCtx({tmp, mtimeLimit: 1}));
  assert.equal(row.tag, 'ask');
});
test('no Claude temp folder gives no rows', async () => {
  assert.deepEqual(await agents.collect(fakeCtx({tmp: await tmpdir()})), []);
});
test('Gradle cache is show only with a command', async () => {
  const home = await tmpdir(); await writeTree(home, {'.gradle/caches/x': '1'});
  const [row] = (await heavy.collect(fakeCtx({home, platform: 'linux'}))).filter(r => r.path?.includes('.gradle'));
  assert.equal(row.tag, 'show'); assert.ok(row.command); assert.equal(row.action.type, 'none');
  assert.equal(row.group, 'heavy');
});
test('~/.claude/projects is never a row', async () => {
  const home = await tmpdir(); const tmp = await tmpdir(); await writeTree(home, {'.claude/projects/x/s.jsonl': '1'});
  const rows = [...await agents.collect(fakeCtx({home, tmp})), ...await heavy.collect(fakeCtx({home, tmp}))];
  assert.ok(rows.every(r => !r.path?.includes(path.join('.claude', 'projects'))));
});
test('Docker row sums the sizes; no row when docker fails', async () => {
  const run = async (cmd, args) => {
    if (cmd !== 'docker') return {code: null, stdout: '', stderr: ''};
    if (args.includes('--format')) return {code: 0, stdout: '1.5GB\n500MB\n0B\n', stderr: ''};
    return {code: 0, stdout: 'TYPE', stderr: ''};
  };
  const rows = await heavy.collect(fakeCtx({home: await tmpdir(), platform: 'linux', run}));
  const docker = rows.find(r => r.label.toLowerCase().includes('docker'));
  assert.equal(docker.bytes, 2_000_000_000);
  assert.equal(docker.command, 'docker system prune');
  assert.equal(docker.tag, 'show'); assert.equal(docker.path, null);
  const none = await heavy.collect(fakeCtx({home: await tmpdir(), platform: 'linux', run: async () => ({code: 1, stdout: '', stderr: ''})}));
  assert.ok(none.every(r => !r.label.toLowerCase().includes('docker')));
});
test('Docker size that cannot be parsed gives null bytes', async () => {
  const run = async (cmd, args) => (args.includes('--format') ? {code: 0, stdout: 'lots\n', stderr: ''} : {code: 0, stdout: '', stderr: ''});
  const rows = await heavy.collect(fakeCtx({home: await tmpdir(), platform: 'linux', run}));
  assert.equal(rows.find(r => r.label.toLowerCase().includes('docker')).bytes, null);
});
test('Xcode and CoreSimulator only on macOS, only when they exist', async () => {
  const home = await tmpdir();
  await writeTree(home, {'Library/Developer/Xcode/DerivedData/x': '1', 'Library/Developer/CoreSimulator/y': '1'});
  const mac = await heavy.collect(fakeCtx({home, platform: 'darwin'}));
  assert.deepEqual(mac.map(r => r.command).sort(), ['rm -rf ~/Library/Developer/Xcode/DerivedData', 'xcrun simctl delete unavailable']);
  assert.deepEqual(await heavy.collect(fakeCtx({home, platform: 'linux'})), []);
});
test('Android AVDs and SDK from env or platform default', async () => {
  const home = await tmpdir(); const sdk = await tmpdir();
  await writeTree(home, {'.android/avd/a.avd/x': '1'}); await writeTree(sdk, {'platforms/x': '1'});
  const rows = await heavy.collect(fakeCtx({home, platform: 'linux', env: {ANDROID_HOME: sdk}}));
  assert.deepEqual(rows.map(r => r.path).sort(), [path.join(home, '.android/avd'), sdk].sort());
  assert.ok(rows.every(r => r.command && r.tag === 'show'));
  await writeTree(home, {'Android/Sdk/platforms/y': '1'});
  const dflt = await heavy.collect(fakeCtx({home, platform: 'linux'}));
  assert.ok(dflt.some(r => r.path === path.join(home, 'Android', 'Sdk')));
  assert.equal((await fs.stat(sdk)).isDirectory(), true);
});
test('Claude temp: an empty folder is dated by its own mtime', async () => {
  const tmp = await tmpdir();
  await fs.mkdir(path.join(tmp, 'claude/empty-old'), {recursive: true});
  await fs.mkdir(path.join(tmp, 'claude/empty-new'), {recursive: true});
  const old = new Date(Date.now() - 3 * 86400000);
  await fs.utimes(path.join(tmp, 'claude/empty-old'), old, old);
  const rows = await agents.collect(fakeCtx({tmp, now: Date.now()}));
  const oldRow = rows.find(r => r.path.endsWith('empty-old'));
  assert.equal(oldRow.tag, 'safe');
  assert.equal(oldRow.reason.params.days, 3);
  assert.equal(rows.find(r => r.path.endsWith('empty-new')).tag, 'ask');
});
