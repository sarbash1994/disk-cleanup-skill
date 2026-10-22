import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as browsers from '../skills/disk-cleanup/scripts/lib/collect/browsers.mjs';
import * as caches from '../skills/disk-cleanup/scripts/lib/collect/caches.mjs';
import {makeContext} from '../skills/disk-cleanup/scripts/lib/ctx.mjs';
import {EN} from '../skills/disk-cleanup/scripts/lib/strings.mjs';
import {fakeCtx, tmpdir, writeTree} from './helpers.mjs';

const base = (r) => path.basename(r.path);
const none = {code: null, stdout: '', stderr: ''};

test('Playwright: newest revision keep, older safe', async () => {
  const pw = await tmpdir(); await writeTree(pw, {'chromium-1100/x': '1', 'chromium-1129/x': '1', 'ffmpeg-1010/x': '1'});
  const rows = await browsers.collect(fakeCtx({env: {PLAYWRIGHT_BROWSERS_PATH: pw}}));
  assert.deepEqual(rows.map(r => [path.basename(r.path), r.tag]).sort(),
    [['chromium-1100', 'safe'], ['chromium-1129', 'keep'], ['ffmpeg-1010', 'keep']]);
});

test('Playwright: revisions compare numerically, odd entries are left out, rows carry label, reason and rm', async () => {
  const pw = await tmpdir();
  await writeTree(pw, {'chromium-999/x': '1', 'chromium-1100/x': '1', '.links': null, 'chromium-beta/x': '1', 'notes.txt': 'x'});
  const rows = await browsers.collect(fakeCtx({env: {PLAYWRIGHT_BROWSERS_PATH: pw}}));
  assert.deepEqual(rows.map(base).sort(), ['chromium-1100', 'chromium-999']);
  const old = rows.find(r => base(r) === 'chromium-999');
  const newest = rows.find(r => base(r) === 'chromium-1100');
  assert.equal(old.group, 'browsers');
  assert.equal(old.tag, 'safe');
  assert.equal(old.label, 'Playwright chromium-999');
  assert.equal(old.bytes, null);
  assert.deepEqual(old.reason, {key: 'reason.browser_old', params: {newest: 'chromium-1100'}});
  assert.deepEqual(old.action, {type: 'rm', path: old.path});
  assert.deepEqual(newest.reason, {key: 'reason.browser_newest', params: {}});
});

test('Playwright default folder comes from ctx.platform and ctx.home or LOCALAPPDATA', async () => {
  const home = await tmpdir();
  await writeTree(home, {'.cache/ms-playwright/webkit-2000/x': '1', 'Library/Caches/ms-playwright/webkit-2001/x': '1'});
  const linux = await browsers.collect(fakeCtx({home, platform: 'linux'}));
  assert.deepEqual(linux.map(base), ['webkit-2000']);
  const mac = await browsers.collect(fakeCtx({home, platform: 'darwin'}));
  assert.deepEqual(mac.map(base), ['webkit-2001']);
  const local = await tmpdir(); await writeTree(local, {'ms-playwright/webkit-2002/x': '1'});
  const win = await browsers.collect(fakeCtx({home, platform: 'win32', env: {LOCALAPPDATA: local}}));
  assert.deepEqual(win.map(base), ['webkit-2002']);
});

test('Puppeteer: versions compare numerically per browser, malformed entries are left out', async () => {
  const home = await tmpdir();
  await writeTree(home, {
    '.cache/puppeteer/chrome/linux-9.2.0/x': '1', '.cache/puppeteer/chrome/linux-10.1.0/x': '1',
    '.cache/puppeteer/chrome/junk/x': '1', '.cache/puppeteer/chrome-headless-shell/linux-9.0.0/x': '1',
    '.cache/puppeteer/file.txt': 'x',
  });
  const rows = await browsers.collect(fakeCtx({home, platform: 'linux'}));
  const byVersion = Object.fromEntries(rows.map(r => [`${path.basename(path.dirname(r.path))}/${base(r)}`, r.tag]));
  assert.deepEqual(byVersion, {
    'chrome/linux-9.2.0': 'safe', 'chrome/linux-10.1.0': 'keep', 'chrome-headless-shell/linux-9.0.0': 'keep',
  });
  const old = rows.find(r => base(r) === 'linux-9.2.0');
  assert.equal(old.label, 'Puppeteer chrome linux-9.2.0');
  assert.deepEqual(old.reason, {key: 'reason.browser_old', params: {newest: 'linux-10.1.0'}});
});

test('PUPPETEER_CACHE_DIR overrides the default folder', async () => {
  const pp = await tmpdir(); await writeTree(pp, {'chrome/win64-5.0.0/x': '1'});
  const rows = await browsers.collect(fakeCtx({env: {PUPPETEER_CACHE_DIR: pp}}));
  assert.deepEqual(rows.map(base), ['win64-5.0.0']);
});

test('no browser folders gives no rows', async () => {
  assert.deepEqual(await browsers.collect(fakeCtx()), []);
});

test('npm cache row uses the npm command; missing pnpm is skipped', async () => {
  const cache = await tmpdir(); await writeTree(cache, {'_cacache/a': '1'});
  const run = async (cmd, args) => /^npm/.test(cmd) && args[0] === 'config' ? {code: 0, stdout: cache + '\n', stderr: ''} : {code: null, stdout: '', stderr: ''};
  const rows = await caches.collect(fakeCtx({run}));
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].action.args, ['cache', 'clean', '--force']);
});

test('cache rows: group, tag, label, path, null bytes; failing command or missing folder gives no row', async () => {
  const dir = await tmpdir();
  const gone = path.join(dir, 'gone');
  const run = async (cmd) => {
    if (/^npm/.test(cmd)) return {code: 0, stdout: `${dir}\r\n`, stderr: ''};
    if (/^pnpm/.test(cmd)) return {code: 0, stdout: gone + '\n', stderr: ''};
    if (/^yarn/.test(cmd)) return {code: 1, stdout: dir + '\n', stderr: 'boom'};
    return none;
  };
  const rows = await caches.collect(fakeCtx({run, platform: 'linux'}));
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].group, rows[0].tag, rows[0].label, rows[0].path, rows[0].bytes], ['caches', 'safe', 'npm cache', dir, null]);
  assert.deepEqual(rows[0].action, {type: 'cmd', cmd: 'npm', args: ['cache', 'clean', '--force']});
});

test('pnpm and yarn rows, with .cmd launchers on win32', async () => {
  const dir = await tmpdir();
  const seen = [];
  const run = async (cmd) => { seen.push(cmd); return /^(pnpm|yarn)/.test(cmd) ? {code: 0, stdout: dir + '\n', stderr: ''} : none; };
  const rows = await caches.collect(fakeCtx({run, platform: 'win32', env: {}}));
  assert.deepEqual(rows.map(r => r.label).sort(), ['pnpm cache', 'yarn cache']);
  const pnpm = rows.find(r => r.label === 'pnpm cache');
  assert.deepEqual(pnpm.action, {type: 'cmd', cmd: 'pnpm.cmd', args: ['store', 'prune']});
  assert.deepEqual(pnpm.reason, {key: 'reason.pnpm_prune', params: {}});
  assert.deepEqual(rows.find(r => r.label === 'yarn cache').action, {type: 'cmd', cmd: 'yarn.cmd', args: ['cache', 'clean']});
  assert.ok(seen.includes('npm.cmd') && seen.includes('pnpm.cmd') && seen.includes('yarn.cmd'));
  assert.ok(!seen.includes('python3'));
});

test('bun cache: BUN_INSTALL or ~/.bun, rm action', async () => {
  const home = await tmpdir(); await writeTree(home, {'.bun/install/cache/a': '1'});
  const rows = await caches.collect(fakeCtx({home}));
  const dir = path.join(home, '.bun', 'install', 'cache');
  assert.deepEqual(rows.map(r => [r.label, r.path, r.action]), [['bun cache', dir, {type: 'rm', path: dir}]]);
  const bun = await tmpdir(); await writeTree(bun, {'install/cache/a': '1'});
  const rows2 = await caches.collect(fakeCtx({home, env: {BUN_INSTALL: bun}}));
  assert.equal(rows2[0].path, path.join(bun, 'install', 'cache'));
});

test('pip cache: python3 on posix, py launcher on win32', async () => {
  const dir = await tmpdir();
  const calls = [];
  const run = async (cmd, args) => { calls.push([cmd, ...args]); return /^(python3|py)$/.test(cmd) ? {code: 0, stdout: dir + '\n', stderr: ''} : none; };
  const posix = await caches.collect(fakeCtx({run, platform: 'linux'}));
  assert.deepEqual(posix.map(r => [r.label, r.action]), [['pip cache', {type: 'cmd', cmd: 'python3', args: ['-m', 'pip', 'cache', 'purge']}]]);
  assert.deepEqual(calls.find(c => c[0] === 'python3'), ['python3', '-m', 'pip', 'cache', 'dir']);
  const win = await caches.collect(fakeCtx({run, platform: 'win32'}));
  assert.deepEqual(win.map(r => r.action), [{type: 'cmd', cmd: 'py', args: ['-m', 'pip', 'cache', 'purge']}]);
});

test('new reason keys exist in EN', () => {
  for (const k of ['reason.pnpm_prune', 'reason.cache_clean', 'reason.browser_newest', 'reason.browser_old']) assert.ok(EN[k], k);
});

test('run: a .cmd on win32 goes through the shell and works', {skip: process.platform !== 'win32'}, async () => {
  const res = await makeContext().run('npm.cmd', ['--version']);
  assert.equal(res.code, 0);
  assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('run: an unsafe argument for a .cmd is rejected, not executed', {skip: process.platform !== 'win32'}, async () => {
  const run = makeContext().run;
  for (const bad of ['a&b', 'a|b', 'a^b', 'a%b', 'a<b', 'a>b', 'a\nb']) {
    assert.deepEqual(await run('npm.cmd', [bad]), {code: null, stdout: '', stderr: 'unsafe argument'}, JSON.stringify(bad));
  }
});

test('run: a .cmd name with cmd.exe delimiters is rejected (win32 only, the guard sits in the win32 branch)', {skip: process.platform !== 'win32'}, async () => {
  const run = makeContext().run;
  for (const bad of ['x;y.cmd', 'x=y.cmd', 'x,y.cmd', 'x y.cmd']) {
    assert.deepEqual(await run(bad, []), {code: null, stdout: '', stderr: 'unsafe argument'}, bad);
  }
});
