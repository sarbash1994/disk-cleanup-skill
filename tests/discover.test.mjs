import {test} from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir, writeTree, fakeCtx} from './helpers.mjs';
import {findRepos, defaultRoots} from '../skills/disk-cleanup/scripts/lib/discover.mjs';
import {listDisks} from '../skills/disk-cleanup/scripts/lib/disks.mjs';

test('findRepos finds repos and does not descend into them or node_modules', async () => {
  const r = await tmpdir();
  await writeTree(r, {'a/.git/HEAD': 'x', 'a/inner/.git/HEAD': 'x', 'b/c/.git': 'gitdir: x',
                      'node_modules/d/.git/HEAD': 'x', '.hidden/e/.git/HEAD': 'x', 'AppData/f/.git/HEAD': 'x'});
  const found = (await findRepos([r], fakeCtx({platform: 'win32'}), {maxDepth: 8})).map(p => path.relative(r, p)).sort();
  assert.deepEqual(found, ['a', path.join('b', 'c')]);
});

test('findRepos honours maxDepth', async () => {
  const r = await tmpdir();
  await writeTree(r, {'a/.git/HEAD': 'x', 'b/c/d/.git/HEAD': 'x'});
  const found = (await findRepos([r], fakeCtx({platform: 'linux'}), {maxDepth: 2})).map(p => path.relative(r, p));
  assert.deepEqual(found, ['a']);
});

test('defaultRoots adds an existing folder from the VS Code recent list', async () => {
  const home = await tmpdir(); const proj = await tmpdir();
  await writeTree(home, {'.config/Code/User/globalStorage/storage.json': JSON.stringify({openedPathsList: {entries: [{folderUri: pathToFileURL(proj).href}]}})});
  assert.ok((await defaultRoots(fakeCtx({home, platform: 'linux'}))).includes(proj));
});

test('defaultRoots ignores missing folders, nested folders and unreadable lists', async () => {
  const home = await tmpdir();
  await writeTree(home, {
    'work/app': null,
    '.config/Code/User/globalStorage/storage.json': JSON.stringify({
      openedPathsList: {entries: [{folderUri: pathToFileURL(path.join(home, 'work', 'app')).href},
                                  {folderUri: pathToFileURL(path.join(home, 'gone')).href}]},
      backupWorkspaces: {folders: [{folderUri: pathToFileURL(path.join(home, 'work')).href}]}}),
    '.config/Cursor/User/globalStorage/storage.json': '{not json',
  });
  assert.deepEqual(await defaultRoots(fakeCtx({home, platform: 'linux'})), [home]);
});

test('defaultRoots reads JetBrains recent projects', async () => {
  const appdata = await tmpdir(); const proj = await tmpdir(); const home = await tmpdir();
  await writeTree(appdata, {'JetBrains/WebStorm2026.1/options/recentProjects.xml':
    `<application><component name="RecentProjectsManager"><option name="additionalInfo"><map><entry key="${proj}"/><entry key="$USER_HOME$/nope"/></map></option></component></application>`});
  const roots = await defaultRoots(fakeCtx({home, platform: 'win32', env: {APPDATA: appdata}}));
  assert.ok(roots.includes(proj));
  assert.ok(!roots.some(p => p.endsWith('nope')));
});

test('listDisks reports total and free space', async () => {
  const disks = await listDisks(fakeCtx(), [os.tmpdir()]);
  assert.ok(disks.length >= 1);
  for (const d of disks) {
    assert.ok(d.total > 0);
    assert.ok(d.free <= d.total);
  }
});

test('findRepos searches ordinary folders that share a name with system folders', async () => {
  const home = await tmpdir();
  await writeTree(home, {'dev/app/.git/HEAD': 'x', 'lib/app/.git/HEAD': 'x'});
  const found = await findRepos([home], fakeCtx({home, platform: 'linux'}), {maxDepth: 8});
  assert.deepEqual(found.map(p => path.relative(home, p)).sort(), [path.join('dev', 'app'), path.join('lib', 'app')]);

  const mac = await tmpdir();
  await writeTree(mac, {'private/app/.git/HEAD': 'x'});
  assert.deepEqual(await findRepos([mac], fakeCtx({home: mac, platform: 'darwin'}), {maxDepth: 8}), [path.join(mac, 'private', 'app')]);
});

test('findRepos skips ~/Library on macOS but searches a Library folder elsewhere', async () => {
  const home = await tmpdir(); const work = await tmpdir();
  await writeTree(home, {'Library/app/.git/HEAD': 'x'});
  await writeTree(work, {'Library/app/.git/HEAD': 'x'});
  const ctx = fakeCtx({home, platform: 'darwin'});
  assert.deepEqual(await findRepos([home], ctx, {maxDepth: 8}), []);
  assert.deepEqual(await findRepos([work], ctx, {maxDepth: 8}), [path.join(work, 'Library', 'app')]);
});

test('defaultRoots takes Windows drives from ctx.drives only', async () => {
  const home = await tmpdir(); const drive = await tmpdir();
  assert.ok((await defaultRoots(fakeCtx({home, platform: 'win32', drives: [drive]}))).includes(drive));
  assert.deepEqual(await defaultRoots(fakeCtx({home, platform: 'win32'})), [home]);
});
