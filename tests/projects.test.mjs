import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {collect} from '../skills/disk-cleanup/scripts/lib/collect/projects.mjs';
import {fakeCtx, gitRepo, realRun, setAllMtimes, writeTree} from './helpers.mjs';

const ctxAt = (iso) => fakeCtx({now: Date.parse(iso), run: realRun});
const byName = (rows, name) => rows.find(r => path.basename(r.path) === name);

test('old project: node_modules safe; ignored .next safe; tracked dist not listed', async () => {
  const repo = await gitRepo({files: {'package.json': '{}', '.gitignore': 'node_modules\n.next\n', 'dist/keep.js': '1'},
                              commitDate: '2026-08-01T00:00:00Z'});
  await writeTree(repo, {'node_modules/x/i.js': '1', '.next/cache/a': '1'});
  await setAllMtimes(repo, new Date('2026-08-01'));
  const rows = await collect(ctxAt('2026-10-22'), [repo]);
  assert.deepEqual(rows.map(r => [path.basename(r.path), r.tag]).sort(), [['.next', 'safe'], ['node_modules', 'safe']]);
  const nm = byName(rows, 'node_modules');
  assert.equal(nm.group, 'projects');
  assert.equal(nm.reason.key, 'reason.nm_old');
  assert.equal(nm.reason.params.days, 82);
  assert.deepEqual(nm.action, {type: 'rm', path: path.join(repo, 'node_modules')});
  assert.equal(nm.label, `${path.basename(repo)}/node_modules`);
  assert.equal(nm.bytes, null);
  assert.equal(byName(rows, '.next').reason.key, 'reason.build_ignored');
});

test('recent project: node_modules ask with the age', async () => {
  const repo = await gitRepo({files: {'package.json': '{}', '.gitignore': 'node_modules\n'}, commitDate: '2026-10-20T00:00:00Z'});
  await writeTree(repo, {'node_modules/x/i.js': '1'});
  await setAllMtimes(repo, new Date('2026-10-20'));
  const [row] = await collect(ctxAt('2026-10-22'), [repo]);
  assert.equal(row.tag, 'ask');
  assert.equal(row.reason.key, 'reason.nm_recent');
  assert.equal(row.reason.params.days, 2);
});

test('a recent source edit keeps an old-commit project in ask; fresh build output does not', async () => {
  const repo = await gitRepo({files: {'package.json': '{}', '.gitignore': 'node_modules\ndist\n'}, commitDate: '2026-08-01T00:00:00Z'});
  await writeTree(repo, {'node_modules/x/i.js': '1', 'dist/out.js': '1', 'src/a.js': '1'});
  await setAllMtimes(repo, new Date('2026-08-01'));
  await setAllMtimes(path.join(repo, 'dist'), new Date('2026-10-21'));
  let rows = await collect(ctxAt('2026-10-22'), [repo]);
  assert.equal(byName(rows, 'node_modules').tag, 'safe');
  await setAllMtimes(path.join(repo, 'src'), new Date('2026-10-21'));
  rows = await collect(ctxAt('2026-10-22'), [repo]);
  assert.equal(byName(rows, 'node_modules').tag, 'ask');
});

test('workspace node_modules under packages/* and apps/* get rows', async () => {
  const repo = await gitRepo({files: {'package.json': '{}', '.gitignore': 'node_modules\n', 'packages/a/package.json': '{}', 'apps/b/package.json': '{}'},
                              commitDate: '2026-08-01T00:00:00Z'});
  await writeTree(repo, {'node_modules/x': '1', 'packages/a/node_modules/y': '1', 'apps/b/node_modules/z': '1'});
  await setAllMtimes(repo, new Date('2026-08-01'));
  const rows = await collect(ctxAt('2026-10-22'), [repo]);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r.tag === 'safe' && r.reason.key === 'reason.nm_old'));
  assert.ok(rows.some(r => r.path === path.join(repo, 'packages', 'a', 'node_modules')));
});

test('git missing: node_modules still listed, build outputs are not', async () => {
  const repo = await gitRepo({files: {'package.json': '{}', '.gitignore': '.next\n'}, commitDate: '2026-08-01T00:00:00Z'});
  await writeTree(repo, {'node_modules/x': '1', '.next/a': '1'});
  await setAllMtimes(repo, new Date('2026-08-01'));
  const rows = await collect(fakeCtx({now: Date.parse('2026-10-22')}), [repo]);
  assert.deepEqual(rows.map(r => path.basename(r.path)), ['node_modules']);
  assert.equal(rows[0].tag, 'safe');
});

test('home as a repo: no node_modules or build-output rows for its personal folders', async () => {
  const home = await gitRepo({files: {'README.md': 'dotfiles\n'}, commitDate: '2026-08-01T00:00:00Z'});
  await writeTree(home, {'.gitignore': '*\n', 'package.json': '{}', 'build/notes.txt': 'mine', 'node_modules/x/i.js': '1'});
  await setAllMtimes(home, new Date('2026-08-01'));
  const rows = await collect(fakeCtx({now: Date.parse('2026-10-22'), run: realRun, home}), [home]);
  assert.deepEqual(rows, []);
});

test('build-output rows only for a repo with a top-level package.json', async () => {
  const repo = await gitRepo({files: {'.gitignore': 'build\n'}, commitDate: '2026-08-01T00:00:00Z'});
  await writeTree(repo, {'build/notes.txt': 'not a JS build'});
  await setAllMtimes(repo, new Date('2026-08-01'));
  assert.deepEqual(await collect(ctxAt('2026-10-22'), [repo]), []);
});
