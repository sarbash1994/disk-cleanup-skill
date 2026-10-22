import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir, writeTree} from './helpers.mjs';
import {measureSize, newestMtime} from '../skills/disk-cleanup/scripts/lib/walk.mjs';

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
test('newestMtime returns 0 for an empty or missing folder and honours limit', async () => {
  const d = await tmpdir();
  assert.equal(await newestMtime(d, {}), 0);
  assert.equal(await newestMtime(path.join(d, 'nope'), {}), 0);
  await writeTree(d, {'a': '1', 'b': '2', 'c': '3'});
  const t = new Date('2026-02-02');
  for (const f of ['a', 'b', 'c']) await fs.utimes(path.join(d, f), t, t);
  assert.equal(await newestMtime(d, {limit: 1}), t.getTime());
});
