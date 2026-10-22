import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {EN, loadStrings, t} from '../skills/disk-cleanup/scripts/lib/strings.mjs';
import {makeRow, GROUPS} from '../skills/disk-cleanup/scripts/lib/row.mjs';
import {makeContext} from '../skills/disk-cleanup/scripts/lib/ctx.mjs';
import {tmpdir, SCAN} from './helpers.mjs';

const execFileP = promisify(execFile);

test('t fills placeholders', () => {
  assert.equal(t(EN, 'reason.nm_old', {days: 42}), EN['reason.nm_old'].replace('{days}', '42'));
});

test('loadStrings keeps English for missing or broken keys', async () => {
  const f = path.join(await tmpdir(), 's.json');
  await fs.writeFile(f, JSON.stringify({'tag.safe': 'безопасно', 'reason.nm_old': 'без плейсхолдера', 'nope': 1}));
  const s = loadStrings(f);
  assert.equal(s['tag.safe'], 'безопасно');
  assert.equal(s['reason.nm_old'], EN['reason.nm_old']);
});

test('loadStrings falls back to English for a missing or invalid file', async () => {
  const dir = await tmpdir();
  assert.deepEqual(loadStrings(path.join(dir, 'absent.json')), EN);
  const bad = path.join(dir, 'bad.json');
  await fs.writeFile(bad, '{not json');
  assert.deepEqual(loadStrings(bad), EN);
  assert.deepEqual(loadStrings(), EN);
});

test('scan.mjs strings prints the English table', async () => {
  const {stdout} = await execFileP(process.execPath, [SCAN, 'strings']);
  assert.deepEqual(JSON.parse(stdout), EN);
});

test('scan.mjs exits 2 with usage for an unknown command', async () => {
  await assert.rejects(execFileP(process.execPath, [SCAN, 'bogus']), (e) => e.code === 2 && /usage/i.test(e.stderr));
});

test('makeRow applies defaults', () => {
  const r = makeRow({group: 'caches', label: 'x', tag: 'safe', reason: {key: 'tag.safe', params: {}}});
  assert.equal(r.id, 0);
  assert.equal(r.bytes, null);
  assert.deepEqual(r.action, {type: 'none'});
  assert.equal(r.path, null);
  assert.deepEqual(GROUPS, ['projects', 'caches', 'browsers', 'agents', 'heavy']);
});

test('makeContext run resolves code null for a missing command and never throws', async () => {
  const ctx = makeContext({busy: ['a']});
  assert.deepEqual(ctx.busy, ['a', process.cwd()]);
  const missing = await ctx.run('definitely-not-a-real-command-xyz', []);
  assert.equal(missing.code, null);
  const ok = await ctx.run(process.execPath, ['-e', 'process.stdout.write("hi")']);
  assert.deepEqual({code: ok.code, stdout: ok.stdout}, {code: 0, stdout: 'hi'});
  const timed = await ctx.run(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], {timeoutMs: 200});
  assert.equal(timed.code, null);
});
