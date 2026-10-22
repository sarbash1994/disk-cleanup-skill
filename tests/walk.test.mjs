import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir, writeTree} from './helpers.mjs';
import {measureSize, newestMtime, newestMtimeInfo} from '../skills/disk-cleanup/scripts/lib/walk.mjs';

test('measureSize sums files and counts a hard link once', async () => {
  const d = await tmpdir(); await writeTree(d, {'a.txt': 'x'.repeat(1000), 'sub/b.txt': 'y'.repeat(500)});
  await fs.link(path.join(d, 'a.txt'), path.join(d, 'sub/a-link.txt'));
  assert.equal(await measureSize(d, {deadline: Date.now() + 5000}), 1500);
});
test('measureSize does not follow a symlink or junction', async () => {
  const outside = await tmpdir(); await writeTree(outside, {'big.bin': 'z'.repeat(4000)});
  const d = await tmpdir(); await fs.symlink(outside, path.join(d, 'link'), 'junction');
  assert.equal(await measureSize(d, {deadline: Date.now() + 5000}), 0);
});
test('measureSize returns null past the deadline', async () => {
  const d = await tmpdir(); await writeTree(d, {'a.txt': 'x'});
  assert.equal(await measureSize(d, {deadline: Date.now() - 1}), null);
});
test('measureSize skips an unreadable folder', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const d = await tmpdir(); await writeTree(d, {'ok.txt': 'x'.repeat(10), 'locked/secret.txt': 'y'});
  await fs.chmod(path.join(d, 'locked'), 0o000);
  assert.equal(await measureSize(d, {deadline: Date.now() + 5000}), 10);
  await fs.chmod(path.join(d, 'locked'), 0o755);
});
test('measureSize handles a folder with more files than the concurrency limit', async () => {
  const d = await tmpdir(); const tree = {};
  for (let i = 0; i < 200; i++) tree[`deep/f${i}.txt`] = 'ab';
  await writeTree(d, tree);
  assert.equal(await measureSize(d, {deadline: Date.now() + 5000}), 400);
});
test('newestMtime ignores node_modules', async () => {
  const d = await tmpdir(); await writeTree(d, {'src/a.js': '1', 'node_modules/x/i.js': '2'});
  const old = new Date('2026-01-01'); await fs.utimes(path.join(d, 'src/a.js'), old, old);
  assert.equal(await newestMtime(d, {}), old.getTime());
});
test('newestMtime returns 0 for an empty or missing folder', async () => {
  const d = await tmpdir();
  assert.equal(await newestMtime(d, {}), 0);
  assert.equal(await newestMtime(path.join(d, 'nope'), {}), 0);
});
test('newestMtime stops after limit entries', async () => {
  const d = await tmpdir(); await writeTree(d, {'x/new.txt': '1'});
  const t = new Date('2026-02-02'); await fs.utimes(path.join(d, 'x/new.txt'), t, t);
  assert.equal(await newestMtime(d, {}), t.getTime());
  // The root's only entry `x` uses up the limit before x is descended.
  assert.equal(await newestMtime(d, {limit: 1}), 0);
});
test('newestMtimeInfo is complete for a small tree, incomplete at the limit or for a missing root', async () => {
  const d = await tmpdir(); await writeTree(d, {'x/new.txt': '1', 'y.txt': '2'});
  const t = new Date('2026-02-02'); await fs.utimes(path.join(d, 'x/new.txt'), t, t);
  await fs.utimes(path.join(d, 'y.txt'), new Date('2026-01-01'), new Date('2026-01-01'));
  assert.deepEqual(await newestMtimeInfo(d, {}), {newest: t.getTime(), complete: true, gitSeen: false});
  assert.equal((await newestMtimeInfo(d, {limit: 1})).complete, false);
  assert.deepEqual(await newestMtimeInfo(path.join(d, 'nope'), {}), {newest: 0, complete: false, gitSeen: false});
  const empty = await tmpdir();
  assert.deepEqual(await newestMtimeInfo(empty, {}), {newest: 0, complete: true, gitSeen: false});
});

test('newestMtimeInfo reports a .git met at any depth', async () => {
  const d = await tmpdir();
  await writeTree(d, {'a/b/.git/HEAD': 'x', 'a/b/c.txt': '1'});
  assert.equal((await newestMtimeInfo(d, {})).gitSeen, true);
  const plain = await tmpdir();
  await writeTree(plain, {'a/b/c.txt': '1'});
  assert.equal((await newestMtimeInfo(plain, {})).gitSeen, false);
});
