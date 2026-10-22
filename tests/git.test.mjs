import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {checkWorktree, classifyBranch, collect, listWorktrees} from '../skills/disk-cleanup/scripts/lib/collect/git.mjs';
import {addWorktree, fakeCtx, gitRepoWithOrigin, realRun, writeTree} from './helpers.mjs';

const DAY = 86_400_000;
// Two days ahead, so files the fixture just wrote do not count as changed in the last 24 h.
const later = (extra = {}) => fakeCtx({now: Date.now() + 2 * DAY, run: realRun, ...extra});
const noGh = async (cmd, args, opts) => (cmd === 'gh' ? {code: null, stdout: '', stderr: ''} : realRun(cmd, args, opts));
const withPrs = (prs) => async (cmd, args, opts) =>
  (cmd === 'gh' ? {code: 0, stdout: JSON.stringify(prs), stderr: ''} : realRun(cmd, args, opts));
const rowAt = (rows, p) => rows.find(r => r.path === p);
const git = (cwd, ...args) => execFileSync('git', args, {cwd, stdio: 'pipe', encoding: 'utf8'});

test('landed worktree is safe, dirty one keep, local-only commits keep', async () => {
  const {repo} = await gitRepoWithOrigin();
  const landed = await addWorktree(repo, 'feat/landed', {commit: true, mergeIntoMainAndPush: true});
  const dirty = await addWorktree(repo, 'feat/dirty', {commit: true, mergeIntoMainAndPush: true, untracked: 'x.txt'});
  const local = await addWorktree(repo, 'feat/local', {commit: true});
  const rows = await collect(fakeCtx({now: Date.now() + 2 * DAY, run: realRun}), [repo]);
  const tag = p => rows.find(r => r.path === p).tag;
  assert.equal(tag(landed), 'safe'); assert.equal(tag(dirty), 'keep'); assert.equal(tag(local), 'keep');
  const row = rowAt(rows, landed);
  assert.equal(row.group, 'projects');
  assert.equal(row.reason.key, 'reason.git_landed');
  assert.deepEqual(row.action, {type: 'worktree', repo, path: landed, branch: 'feat/landed'});
  assert.equal(row.label, `${path.basename(repo)}/.claude/worktrees/feat-landed`);
  assert.equal(rowAt(rows, dirty).reason.key, 'reason.git_dirty');
  assert.equal(rowAt(rows, local).reason.key, 'reason.git_local_commits');
  assert.equal(rows.some(r => r.path === repo && r.action.type === 'worktree'), false, 'the main checkout is never a row');
});

test('cherry-picked branch counts as landed', async () => {
  const {repo} = await gitRepoWithOrigin();
  const cp = await addWorktree(repo, 'feat/cp', {commit: true, cherryPickIntoMainAndPush: true});
  assert.throws(() => git(repo, 'merge-base', '--is-ancestor', 'feat/cp', 'origin/main'), 'fixture: the branch is no ancestor');
  const rows = await collect(later(), [repo]);
  assert.equal(rowAt(rows, cp).tag, 'safe');
  assert.equal(rowAt(rows, cp).reason.key, 'reason.git_landed');
  const info = await classifyBranch(repo, 'feat/cp', {prs: null, base: 'origin/main', current: 'main'}, later());
  assert.deepEqual(info, {landed: true, keep: null});
});

test('worktree under a busy dir or changed in the last 24 h is keep', async () => {
  const {repo} = await gitRepoWithOrigin();
  const wt = await addWorktree(repo, 'feat/landed', {commit: true, mergeIntoMainAndPush: true});
  const busyRows = await collect(later({busy: [wt]}), [repo]);
  assert.equal(rowAt(busyRows, wt).tag, 'keep');
  assert.equal(rowAt(busyRows, wt).reason.key, 'reason.git_busy');
  const sessionInside = await collect(later({busy: [path.join(wt, 'src')]}), [repo]);
  assert.equal(rowAt(sessionInside, wt).tag, 'keep', 'a session in a subfolder of the worktree');
  const recentRows = await collect(fakeCtx({now: Date.now(), run: realRun}), [repo]);
  assert.equal(rowAt(recentRows, wt).tag, 'keep');
  assert.equal(rowAt(recentRows, wt).reason.key, 'reason.git_busy');
  const idle = await collect(later(), [repo]);
  assert.equal(rowAt(idle, wt).tag, 'safe', 'the same worktree is safe when idle');
});

test('without gh data an unmerged pushed branch is ask', async () => {
  const {repo} = await gitRepoWithOrigin();
  const wt = await addWorktree(repo, 'feat/pushed', {commit: true, push: true});
  const rows = await collect(later({run: noGh}), [repo]);
  assert.equal(rowAt(rows, wt).tag, 'ask');
  assert.equal(rowAt(rows, wt).reason.key, 'reason.git_no_pr_data');
});

test('PR data: open PR keep, closed PR ask, merged PR safe with its number', async () => {
  const {repo} = await gitRepoWithOrigin();
  const open = await addWorktree(repo, 'feat/open', {commit: true, mergeIntoMainAndPush: true});
  const closed = await addWorktree(repo, 'feat/closed', {commit: true, push: true});
  const merged = await addWorktree(repo, 'feat/merged', {commit: true, push: true});
  const prs = [
    {number: 7, state: 'OPEN', headRefName: 'feat/open'},
    {number: 8, state: 'CLOSED', headRefName: 'feat/closed'},
    {number: 9, state: 'MERGED', headRefName: 'feat/merged', headRefOid: git(merged, 'rev-parse', 'HEAD').trim()},
  ];
  const rows = await collect(later({run: withPrs(prs)}), [repo]);
  assert.equal(rowAt(rows, open).tag, 'keep', 'an open PR keeps even a landed branch');
  assert.deepEqual(rowAt(rows, open).reason, {key: 'reason.git_open_pr', params: {pr: 7}});
  assert.equal(rowAt(rows, closed).tag, 'ask');
  assert.equal(rowAt(rows, closed).reason.key, 'reason.git_unmerged');
  assert.equal(rowAt(rows, merged).tag, 'safe');
  assert.deepEqual(rowAt(rows, merged).reason, {key: 'reason.git_landed', params: {pr: 9}});
});

test('locked worktree keep; detached HEAD safe when on a remote, keep with a local commit', async () => {
  const {repo} = await gitRepoWithOrigin();
  const locked = await addWorktree(repo, 'feat/locked', {commit: true, mergeIntoMainAndPush: true, lock: true});
  const pushedHead = await addWorktree(repo, 'detached-a', {detach: true});
  const localHead = await addWorktree(repo, 'detached-b', {detach: true, commit: true});
  const rows = await collect(later(), [repo]);
  assert.equal(rowAt(rows, locked).tag, 'keep');
  assert.equal(rowAt(rows, locked).reason.key, 'reason.git_locked');
  assert.equal(rowAt(rows, pushedHead).tag, 'safe');
  assert.equal(rowAt(rows, pushedHead).reason.key, 'reason.git_detached_pushed');
  assert.deepEqual(rowAt(rows, pushedHead).action, {type: 'worktree', repo, path: pushedHead, branch: null});
  assert.equal(rowAt(rows, localHead).tag, 'keep');
  assert.equal(rowAt(rows, localHead).reason.key, 'reason.git_local_commits');
});

test('orphan folder and a loose log are safe rows', async () => {
  const {repo} = await gitRepoWithOrigin();
  const real = await addWorktree(repo, 'feat/landed', {commit: true, mergeIntoMainAndPush: true});
  await writeTree(repo, {
    '.claude/worktrees/ghost/file.js': '1',
    '.claude/worktrees/a.log': 'log',
    '.claude/worktrees/notes.json': '{}',
    '.worktrees/old/x': '1',
    '.worktrees/run.txt': 'txt',
  });
  const rows = await collect(later(), [repo]);
  const ghost = path.join(repo, '.claude', 'worktrees', 'ghost');
  const log = path.join(repo, '.claude', 'worktrees', 'a.log');
  assert.equal(rowAt(rows, ghost).tag, 'safe');
  assert.equal(rowAt(rows, ghost).reason.key, 'reason.git_orphan');
  assert.deepEqual(rowAt(rows, ghost).action, {type: 'rm', path: ghost});
  assert.equal(rowAt(rows, log).tag, 'safe');
  assert.equal(rowAt(rows, log).reason.key, 'reason.git_loose_log');
  assert.deepEqual(rowAt(rows, log).action, {type: 'rm', path: log});
  assert.equal(rowAt(rows, path.join(repo, '.worktrees', 'old')).reason.key, 'reason.git_orphan');
  assert.equal(rowAt(rows, path.join(repo, '.worktrees', 'run.txt')).reason.key, 'reason.git_loose_log');
  assert.equal(rowAt(rows, path.join(repo, '.claude', 'worktrees', 'notes.json')), undefined);
  assert.equal(rows.filter(r => r.path === real).length, 1, 'a known worktree is not an orphan');
  assert.equal(rowAt(rows, real).action.type, 'worktree');
});

test('orphan folders alone make a repo handled', async () => {
  const {repo} = await gitRepoWithOrigin();
  await writeTree(repo, {'.claude/worktrees/ghost/file.js': '1'});
  const rows = await collect(later(), [repo]);
  assert.deepEqual(rows.map(r => [path.basename(r.path), r.tag, r.reason.key]), [['ghost', 'safe', 'reason.git_orphan']]);
});

test('repo without worktrees yields no rows', async () => {
  const {repo} = await gitRepoWithOrigin();
  git(repo, 'branch', 'feat/landed-no-worktree');
  assert.deepEqual(await collect(later(), [repo]), []);
});

test('repo without a remote is skipped', async () => {
  const {repo} = await gitRepoWithOrigin();
  await addWorktree(repo, 'feat/landed', {commit: true, mergeIntoMainAndPush: true});
  git(repo, 'remote', 'remove', 'origin');
  assert.deepEqual(await collect(later(), [repo]), []);
});

test('one show row counts landed local branches without a worktree', async () => {
  const {repo} = await gitRepoWithOrigin();
  await addWorktree(repo, 'feat/wt', {commit: true, mergeIntoMainAndPush: true});
  git(repo, 'branch', 'feat/a');
  git(repo, 'branch', 'feat/b');
  git(repo, 'switch', '-q', '-c', 'feat/unlanded');
  await writeTree(repo, {'u.txt': 'u'});
  git(repo, 'add', 'u.txt');
  git(repo, 'commit', '-q', '-m', 'u');
  git(repo, 'switch', '-q', 'main');
  const rows = await collect(later(), [repo]);
  const count = rows.filter(r => r.reason.key === 'reason.git_branch_count');
  assert.equal(count.length, 1);
  assert.equal(count[0].tag, 'show');
  assert.equal(count[0].bytes, 0);
  assert.deepEqual(count[0].reason.params, {count: 2});
  assert.deepEqual(count[0].action, {type: 'none'});
});

test('a linked worktree passed as a repo adds no rows of its own', async () => {
  const {repo} = await gitRepoWithOrigin();
  const wt = await addWorktree(repo, 'feat/landed', {commit: true, mergeIntoMainAndPush: true});
  const rows = await collect(later(), [repo, wt]);
  assert.equal(rows.filter(r => r.path === wt).length, 1);
});

test('listWorktrees parses the porcelain output', async () => {
  const {repo} = await gitRepoWithOrigin();
  const wt = await addWorktree(repo, 'feat/x', {lock: true});
  const det = await addWorktree(repo, 'det', {detach: true});
  const list = await listWorktrees(repo, later());
  assert.equal(list.length, 3);
  assert.equal(list[0].path, repo);
  assert.equal(list[0].branch, 'main');
  const byPath = p => list.find(w => w.path === p);
  assert.deepEqual({...byPath(wt), head: 'x'}, {path: wt, head: 'x', branch: 'feat/x', locked: true});
  assert.match(byPath(wt).head, /^[0-9a-f]{40}$/);
  assert.deepEqual({...byPath(det), head: 'x'}, {path: det, head: 'x', branch: null, locked: false});
});

test('checkWorktree re-checks a row: a new local commit turns safe into keep', async () => {
  const {repo} = await gitRepoWithOrigin();
  const wt = await addWorktree(repo, 'feat/landed', {commit: true, mergeIntoMainAndPush: true});
  const opts = {prs: null, base: 'origin/main', current: 'main'};
  const entry = () => listWorktrees(repo, later()).then(list => list.find(w => w.path === wt));
  assert.deepEqual(await checkWorktree(repo, await entry(), opts, later()),
    {tag: 'safe', reasonKey: 'reason.git_landed', params: {}});
  await writeTree(wt, {'more.txt': 'more'});
  git(wt, 'add', 'more.txt');
  git(wt, 'commit', '-q', '-m', 'more');
  assert.deepEqual(await checkWorktree(repo, await entry(), opts, later()),
    {tag: 'keep', reasonKey: 'reason.git_local_commits', params: {}});
});

test('a MERGED PR lands a branch only when the local tip is the PR head or behind it', async () => {
  const {repo} = await gitRepoWithOrigin();
  // feat/x: PR #9 merged at commit A, then a new commit B pushed to the same branch name.
  const moved = await addWorktree(repo, 'feat/x', {commit: true, push: true});
  const prHead = git(moved, 'rev-parse', 'HEAD').trim();
  await writeTree(moved, {'b.txt': 'b'});
  git(moved, 'add', 'b.txt');
  git(moved, 'commit', '-q', '-m', 'B');
  git(moved, 'push', '-q', 'origin', 'feat/x');
  // feat/behind: PR head is one commit ahead of the local tip.
  const behind = await addWorktree(repo, 'feat/behind', {commit: true});
  await writeTree(behind, {'c.txt': 'c'});
  git(behind, 'add', 'c.txt');
  git(behind, 'commit', '-q', '-m', 'C');
  git(behind, 'push', '-q', 'origin', 'feat/behind');
  const behindHead = git(behind, 'rev-parse', 'HEAD').trim();
  git(behind, 'reset', '-q', '--hard', 'HEAD~1');
  // feat/gone: the PR head commit is not present locally.
  const gone = await addWorktree(repo, 'feat/gone', {commit: true, push: true});
  const prs = [
    {number: 9, state: 'MERGED', headRefName: 'feat/x', headRefOid: prHead},
    {number: 10, state: 'MERGED', headRefName: 'feat/behind', headRefOid: behindHead},
    {number: 11, state: 'MERGED', headRefName: 'feat/gone', headRefOid: 'f'.repeat(40)},
  ];
  const rows = await collect(later({run: withPrs(prs)}), [repo]);
  assert.equal(rowAt(rows, moved).tag, 'ask');
  assert.equal(rowAt(rows, moved).reason.key, 'reason.git_unmerged');
  assert.deepEqual(rowAt(rows, behind).reason, {key: 'reason.git_landed', params: {pr: 10}});
  assert.equal(rowAt(rows, behind).tag, 'safe');
  assert.equal(rowAt(rows, gone).tag, 'ask');
  const opts = {prs, base: 'origin/main', current: 'main'};
  assert.deepEqual(await classifyBranch(repo, 'feat/x', opts, later()), {landed: false, keep: null});
});

test('an orphan folder that is busy, fresh or holds .git is not safe', async () => {
  const {repo} = await gitRepoWithOrigin();
  await writeTree(repo, {
    '.claude/worktrees/busy/a.js': '1',
    '.claude/worktrees/clone/.git/HEAD': 'ref: refs/heads/main\n',
    '.claude/worktrees/clone/src.js': '1',
    '.claude/worktrees/moved/.git': 'gitdir: /somewhere/else\n',
    '.claude/worktrees/moved/src.js': '1',
  });
  const p = name => path.join(repo, '.claude', 'worktrees', name);
  const rows = await collect(later({busy: [path.join(p('busy'), 'src')]}), [repo]);
  assert.deepEqual(rowAt(rows, p('busy')).reason.key, 'reason.git_busy');
  assert.equal(rowAt(rows, p('busy')).tag, 'keep');
  assert.equal(rowAt(rows, p('clone')).tag, 'ask');
  assert.equal(rowAt(rows, p('clone')).reason.key, 'reason.git_orphan_repo');
  assert.equal(rowAt(rows, p('moved')).tag, 'ask');
  assert.equal(rowAt(rows, p('moved')).reason.key, 'reason.git_orphan_repo');
  const fresh = await collect(fakeCtx({now: Date.now(), run: realRun}), [repo]);
  for (const name of ['busy', 'clone', 'moved']) {
    assert.equal(rowAt(fresh, p(name)).tag, 'keep', `${name} changed in the last 24 h`);
    assert.equal(rowAt(fresh, p(name)).reason.key, 'reason.git_busy');
  }
});

test('an incomplete recency scan counts as in use', async () => {
  const {repo} = await gitRepoWithOrigin();
  const wt = await addWorktree(repo, 'feat/landed', {commit: true, mergeIntoMainAndPush: true});
  await writeTree(repo, {'.claude/worktrees/ghost/a.js': '1', '.claude/worktrees/ghost/b.js': '2'});
  const rows = await collect(later({mtimeLimit: 1}), [repo]);
  assert.equal(rowAt(rows, wt).tag, 'keep');
  assert.equal(rowAt(rows, wt).reason.key, 'reason.git_busy');
  const ghost = path.join(repo, '.claude', 'worktrees', 'ghost');
  assert.equal(rowAt(rows, ghost).tag, 'keep');
  assert.equal(rowAt(rows, ghost).reason.key, 'reason.git_busy');
  assert.equal(rowAt(await collect(later(), [repo]), wt).tag, 'safe', 'safe with the default limit');
});

test('branch count includes ancestor-landed and cherry-landed branches, not unlanded or open-PR ones', async () => {
  const {repo} = await gitRepoWithOrigin();
  await addWorktree(repo, 'feat/wt', {commit: true, mergeIntoMainAndPush: true});
  const cp = await addWorktree(repo, 'feat/cp', {commit: true, cherryPickIntoMainAndPush: true});
  git(repo, 'worktree', 'remove', '--force', cp);
  git(repo, 'branch', 'feat/anc');
  git(repo, 'branch', 'feat/anc-open');
  git(repo, 'switch', '-q', '-c', 'feat/unlanded');
  await writeTree(repo, {'u.txt': 'u'});
  git(repo, 'add', 'u.txt');
  git(repo, 'commit', '-q', '-m', 'u');
  git(repo, 'switch', '-q', 'main');
  const run = withPrs([{number: 7, state: 'OPEN', headRefName: 'feat/anc-open'}]);
  const rows = await collect(later({run}), [repo]);
  const count = rows.find(r => r.reason.key === 'reason.git_branch_count');
  assert.deepEqual(count.reason.params, {count: 2});
});

test('untracked files count as changes even with status.showUntrackedFiles=no', async () => {
  const {repo} = await gitRepoWithOrigin();
  git(repo, 'config', 'status.showUntrackedFiles', 'no');
  const wt = await addWorktree(repo, 'feat/landed', {commit: true, mergeIntoMainAndPush: true, untracked: 'notes.txt'});
  const rows = await collect(later({run: noGh}), [repo]);
  assert.equal(rowAt(rows, wt).tag, 'keep');
  assert.equal(rowAt(rows, wt).reason.key, 'reason.git_dirty');
});

test('a squash-merged branch whose remote branch is gone is safe through its verified merged PR', async () => {
  const {repo} = await gitRepoWithOrigin();
  const wt = await addWorktree(repo, 'feat/sq', {commit: true, push: true});
  await writeTree(wt, {'second.txt': '2\n'});
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'second');
  git(wt, 'push', '-q', 'origin', 'feat/sq');
  const tip = git(wt, 'rev-parse', 'HEAD').trim();
  git(repo, 'merge', '-q', '--squash', 'feat/sq');
  git(repo, 'commit', '-q', '-m', 'squash feat/sq');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'push', '-q', 'origin', '--delete', 'feat/sq');
  git(repo, 'fetch', '-q', '--prune', 'origin');
  const prs = [{number: 12, state: 'MERGED', headRefName: 'feat/sq', headRefOid: tip}];
  const rows = await collect(later({run: withPrs(prs)}), [repo]);
  assert.equal(rowAt(rows, wt).tag, 'safe');
  assert.deepEqual(rowAt(rows, wt).reason, {key: 'reason.git_landed', params: {pr: 12}});
  // Without PR data the same branch has commits on no remote.
  assert.equal(rowAt(await collect(later({run: noGh}), [repo]), wt).reason.key, 'reason.git_local_commits');
});

test('an orphan folder with a .git deeper inside is ask', async () => {
  const {repo} = await gitRepoWithOrigin();
  await writeTree(repo, {
    '.claude/worktrees/nested/pkg/sub/.git/HEAD': 'ref: refs/heads/main\n',
    '.claude/worktrees/nested/pkg/sub/a.js': '1',
  });
  const nested = path.join(repo, '.claude', 'worktrees', 'nested');
  const rows = await collect(later({run: noGh}), [repo]);
  assert.equal(rowAt(rows, nested).tag, 'ask');
  assert.equal(rowAt(rows, nested).reason.key, 'reason.git_orphan_repo');
});

test('a worktree with submodules is ask at report time', async () => {
  const {repo} = await gitRepoWithOrigin();
  const wt = await addWorktree(repo, 'feat/sub');
  await writeTree(wt, {'.gitmodules': '[submodule "lib"]\n\tpath = lib\n\turl = ../lib.git\n'});
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'add submodule config');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge feat/sub', 'feat/sub');
  git(repo, 'push', '-q', 'origin', 'main');
  const rows = await collect(later({run: noGh}), [repo]);
  assert.equal(rowAt(rows, wt).tag, 'ask');
  assert.equal(rowAt(rows, wt).reason.key, 'reason.git_submodules');
});
