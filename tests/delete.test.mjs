import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {makeRow} from '../skills/disk-cleanup/scripts/lib/row.mjs';
import {buildReport} from '../skills/disk-cleanup/scripts/lib/report.mjs';
import {deleteRows, parseIds} from '../skills/disk-cleanup/scripts/lib/delete.mjs';
import * as git from '../skills/disk-cleanup/scripts/lib/collect/git.mjs';
import * as agents from '../skills/disk-cleanup/scripts/lib/collect/agents.mjs';
import {SCAN, addWorktree, fakeCtx, gitRepoWithOrigin, realRun, tmpdir, writeTree} from './helpers.mjs';

const execFileP = promisify(execFile);
const DAY = 86_400_000;
const noGh = async (cmd, args, opts) => (cmd === 'gh' ? {code: null, stdout: '', stderr: ''} : realRun(cmd, args, opts));
// Two days ahead, so files the fixture just wrote do not count as changed in the last 24 h.
const later = (extra = {}) => fakeCtx({now: Date.now() + 2 * DAY, run: noGh, ...extra});
const gitOut = (cwd, ...args) => execFileSync('git', args, {cwd, stdio: 'pipe', encoding: 'utf8'});
const exists = (p) => fs.lstat(p).then(() => true, () => false);
const rmRow = (p, tag = 'safe', extra = {}) => makeRow({
  group: 'projects', label: path.basename(p), path: p, bytes: 1, tag,
  reason: {key: 'reason.nm_old', params: {days: 40}}, action: {type: 'rm', path: p}, ...extra,
});
const idOf = (report, p) => report.groups.flatMap(g => g.rows).find(r => r.path === p).id;
const byId = (results, id) => results.find(r => r.id === id);

test('parseIds handles lists and ranges', () => {
  assert.deepEqual(parseIds('1, 3,5-7 3'), [1, 3, 5, 6, 7]);
  assert.deepEqual(parseIds(' 4 '), [4]);
  assert.deepEqual(parseIds('2-2,1'), [1, 2]);
  assert.throws(() => parseIds('1; rm -rf'));
  assert.throws(() => parseIds(''));
  assert.throws(() => parseIds('7-5'));
  assert.throws(() => parseIds('1,,2'));
  assert.throws(() => parseIds('0'));
  assert.throws(() => parseIds('1-99999999'));
});

test('keep, show and unknown rows are skipped, safe rm row deleted', async () => {
  const base = await tmpdir();
  await writeTree(base, {'safe/a.bin': '12345', 'keep/b.bin': 'b', 'show/c.bin': 'c'});
  const p = name => path.join(base, name);
  const gone = p('gone');
  const report = buildReport([
    rmRow(p('safe'), 'safe', {bytes: 5}),
    rmRow(p('keep'), 'keep'),
    makeRow({group: 'heavy', label: 'show', path: p('show'), bytes: 1, tag: 'show',
      reason: {key: 'reason.heavy_show', params: {}}, command: 'docker system prune'}),
    rmRow(gone, 'safe'),
  ], [], {now: Date.now()});
  const ids = {safe: idOf(report, p('safe')), keep: idOf(report, p('keep')), show: idOf(report, p('show')), gone: idOf(report, gone)};
  const results = await deleteRows(report, [ids.safe, ids.keep, ids.show, ids.gone, 99], fakeCtx());

  assert.deepEqual(results.map(r => r.id), [ids.safe, ids.keep, ids.show, ids.gone, 99]);
  assert.deepEqual(byId(results, ids.safe), {id: ids.safe, status: 'deleted', freed: 5, message: 'deleted'});
  assert.equal(byId(results, ids.keep).status, 'skipped');
  assert.match(byId(results, ids.keep).message, /keep/);
  assert.equal(byId(results, ids.show).status, 'skipped');
  assert.equal(byId(results, ids.gone).status, 'skipped');
  assert.match(byId(results, ids.gone).message, /no longer exists/);
  assert.deepEqual(byId(results, 99), {id: 99, status: 'skipped', freed: 0, message: 'not in the report'});
  assert.equal(await exists(p('safe')), false);
  assert.equal(await exists(p('keep/b.bin')), true);
  assert.equal(await exists(p('show/c.bin')), true);
});

test('rm through a symlink is refused and the target survives', async () => {
  const base = await tmpdir();
  await writeTree(base, {'target/keep.txt': 'precious'});
  const target = path.join(base, 'target');
  const link = path.join(base, 'link');
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const report = buildReport([rmRow(link)], [], {now: Date.now()});
  const [result] = await deleteRows(report, [1], fakeCtx());
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /link/);
  assert.equal(result.freed, 0);
  assert.equal(await exists(link), true, 'the link itself is left alone');
  assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'precious');
});

test('a link inside a deleted folder is removed without touching its target', async () => {
  const base = await tmpdir();
  await writeTree(base, {'outside/keep.txt': 'precious', 'proj/node_modules/real.js': '1'});
  const nm = path.join(base, 'proj', 'node_modules');
  await fs.symlink(path.join(base, 'outside'), path.join(nm, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const report = buildReport([rmRow(nm)], [], {now: Date.now()});
  const [result] = await deleteRows(report, [1], fakeCtx());
  assert.equal(result.status, 'deleted');
  assert.equal(result.freed, 1, 'the size does not count the link target');
  assert.equal(await exists(nm), false);
  assert.equal(await fs.readFile(path.join(base, 'outside', 'keep.txt'), 'utf8'), 'precious');
});

test('worktree that got a new local commit after the report is skipped', async () => {
  const {repo} = await gitRepoWithOrigin();
  const wt = await addWorktree(repo, 'feat/landed', {commit: true, mergeIntoMainAndPush: true});
  const ctx = later();
  const report = buildReport(await git.collect(ctx, [repo]), [], {now: Date.now()});
  const id = idOf(report, wt);
  assert.equal(report.groups[0].rows.find(r => r.id === id).tag, 'safe', 'fixture: safe in the report');

  await writeTree(wt, {'late.txt': 'late\n'});
  gitOut(wt, 'add', '-A');
  gitOut(wt, 'commit', '-q', '-m', 'late work');

  const [result] = await deleteRows(report, [id], ctx);
  assert.equal(result.status, 'skipped');
  assert.equal(result.freed, 0);
  assert.match(result.message, /commits that are on no remote/);
  assert.equal(await exists(path.join(wt, 'late.txt')), true);
  assert.match(gitOut(repo, 'branch', '--list', 'feat/landed'), /feat\/landed/);
});

test('a landed worktree is removed with its local branch, the remote branch stays', async () => {
  const {repo, origin} = await gitRepoWithOrigin();
  const wt = await addWorktree(repo, 'feat/done', {commit: true, push: true, mergeIntoMainAndPush: true});
  const ctx = later();
  const report = buildReport(await git.collect(ctx, [repo]), [], {now: Date.now()});
  const [result] = await deleteRows(report, [idOf(report, wt)], ctx);
  assert.equal(result.status, 'deleted', result.message);
  assert.ok(result.freed > 0);
  assert.equal(await exists(wt), false);
  assert.doesNotMatch(gitOut(repo, 'worktree', 'list'), /feat-done/);
  assert.equal(gitOut(repo, 'branch', '--list', 'feat/done').trim(), '');
  assert.match(gitOut(origin, 'branch', '--list', 'feat/done'), /feat\/done/, 'remote branches are not deleted');
});

test('a worktree git no longer lists is skipped', async () => {
  const {repo} = await gitRepoWithOrigin();
  const wt = await addWorktree(repo, 'feat/landed', {commit: true, mergeIntoMainAndPush: true});
  const ctx = later();
  const report = buildReport(await git.collect(ctx, [repo]), [], {now: Date.now()});
  gitOut(repo, 'worktree', 'remove', wt);
  await writeTree(wt, {'new.txt': 'someone else\n'});
  const [result] = await deleteRows(report, [idOf(report, wt)], ctx);
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /no longer a git worktree/);
  assert.equal(await exists(path.join(wt, 'new.txt')), true);
});

test('an orphan folder that became busy is skipped, an idle one deleted', async () => {
  const {repo} = await gitRepoWithOrigin();
  await writeTree(repo, {'.claude/worktrees/ghost/a.js': '1', '.claude/worktrees/idle/b.js': '22'});
  const ghost = path.join(repo, '.claude', 'worktrees', 'ghost');
  const idle = path.join(repo, '.claude', 'worktrees', 'idle');
  const report = buildReport(await git.collect(later(), [repo]), [], {now: Date.now()});
  const results = await deleteRows(report, [idOf(report, ghost), idOf(report, idle)], later({busy: [ghost]}));
  assert.equal(byId(results, idOf(report, ghost)).status, 'skipped');
  assert.match(byId(results, idOf(report, ghost)).message, /in use/);
  assert.equal(await exists(path.join(ghost, 'a.js')), true);
  assert.deepEqual(byId(results, idOf(report, idle)), {id: idOf(report, idle), status: 'deleted', freed: 2, message: 'deleted'});
  assert.equal(await exists(idle), false);
});

test('an orphan folder that git now knows as a worktree is skipped', async () => {
  const {repo} = await gitRepoWithOrigin();
  await writeTree(repo, {'.claude/worktrees/ghost/a.js': '1'});
  const ghost = path.join(repo, '.claude', 'worktrees', 'ghost');
  const report = buildReport(await git.collect(later(), [repo]), [], {now: Date.now()});
  await fs.rm(ghost, {recursive: true});
  gitOut(repo, 'worktree', 'add', '-q', '-b', 'feat/ghost', ghost, 'main');
  const [result] = await deleteRows(report, [idOf(report, ghost)], later());
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /lists this folder as a worktree/);
  assert.equal(await exists(path.join(ghost, 'README.md')), true);
});

test('an agent temp folder that became busy is skipped', async () => {
  const tmp = await tmpdir();
  await writeTree(tmp, {'claude/old/a.txt': 'x', 'claude/old2/b.txt': 'yy'});
  const old = path.join(tmp, 'claude', 'old');
  const old2 = path.join(tmp, 'claude', 'old2');
  const report = buildReport(await agents.collect(later({tmp})), [], {now: Date.now()});
  const results = await deleteRows(report, [idOf(report, old), idOf(report, old2)], later({tmp, busy: [old]}));
  assert.equal(byId(results, idOf(report, old)).status, 'skipped');
  assert.match(byId(results, idOf(report, old)).message, /session may use it/);
  assert.equal(await exists(path.join(old, 'a.txt')), true);
  assert.equal(byId(results, idOf(report, old2)).status, 'deleted');
  assert.equal(await exists(old2), false);
});

test('cmd rows run the command; a failure reports the last stderr line', async () => {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push([cmd, args, opts]);
    return cmd === 'bad' ? {code: 1, stdout: '', stderr: 'first\nlast line\n'} : {code: 0, stdout: '', stderr: ''};
  };
  const cmdRow = (cmd) => makeRow({group: 'caches', label: cmd, bytes: 1, tag: 'safe',
    reason: {key: 'reason.cache_clean', params: {}}, action: {type: 'cmd', cmd, args: ['cache', 'clean', 'с пробелом']}});
  const report = buildReport([cmdRow('good'), cmdRow('bad'), cmdRow('missing')], [], {now: Date.now()});
  const ids = Object.fromEntries(report.groups[0].rows.map(r => [r.label, r.id]));
  const runMissing = async (cmd, args, opts) => (cmd === 'missing' ? {code: null, stdout: '', stderr: ''} : run(cmd, args, opts));
  const results = await deleteRows(report, [ids.good, ids.bad, ids.missing], fakeCtx({run: runMissing}));
  assert.deepEqual(calls[0], ['good', ['cache', 'clean', 'с пробелом'], {timeoutMs: 600000}]);
  assert.deepEqual(byId(results, ids.good), {id: ids.good, status: 'deleted', freed: 0, message: 'deleted'});
  assert.equal(byId(results, ids.bad).status, 'failed');
  assert.match(byId(results, ids.bad).message, /last line/);
  assert.equal(byId(results, ids.missing).status, 'failed');
});

test('a cmd row with a path reports the bytes it freed', async () => {
  const base = await tmpdir();
  await writeTree(base, {'cache/a.bin': '1234', 'cache/b.bin': '56'});
  const cache = path.join(base, 'cache');
  const run = async () => {
    await fs.rm(path.join(cache, 'a.bin'));
    return {code: 0, stdout: '', stderr: ''};
  };
  const report = buildReport([makeRow({group: 'caches', label: 'npm cache', path: cache, bytes: 6, tag: 'safe',
    reason: {key: 'reason.cache_clean', params: {}}, action: {type: 'cmd', cmd: 'npm', args: ['cache', 'clean']}})], [], {now: Date.now()});
  const [result] = await deleteRows(report, [1], fakeCtx({run}));
  assert.deepEqual(result, {id: 1, status: 'deleted', freed: 4, message: 'deleted'});
});

test('folder name with spaces and non-Latin letters is deleted', async () => {
  const base = await tmpdir();
  await writeTree(base, {'проект с пробелом/node_modules/x.js': 'abc', 'проект с пробелом/src/keep.js': 'k'});
  const nm = path.join(base, 'проект с пробелом', 'node_modules');
  const report = buildReport([rmRow(nm)], [], {now: Date.now()});
  const [result] = await deleteRows(report, [1], fakeCtx());
  assert.deepEqual(result, {id: 1, status: 'deleted', freed: 3, message: 'deleted'});
  assert.equal(await exists(nm), false);
  assert.equal(await exists(path.join(base, 'проект с пробелом', 'src', 'keep.js')), true);
});

async function cliEnv() {
  const temp = await tmpdir();
  const env = {PATH: path.dirname(process.execPath), TEMP: temp, TMP: temp, TMPDIR: temp};
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return {temp, env};
}

async function writeReport(temp, report) {
  await fs.mkdir(path.join(temp, 'disk-cleanup'), {recursive: true});
  await fs.writeFile(path.join(temp, 'disk-cleanup', 'report.json'), JSON.stringify(report));
}

test('delete without report.json exits 1 and deletes nothing', async () => {
  const {temp, env} = await cliEnv();
  await writeTree(temp, {'victim/a.txt': 'a'});
  await assert.rejects(
    execFileP(process.execPath, [SCAN, 'delete', '1'], {env}),
    (e) => e.code === 1 && /report/.test(e.stderr),
  );
  assert.equal(await exists(path.join(temp, 'victim', 'a.txt')), true);
});

test('delete with an unknown report version exits 1 and deletes nothing', async () => {
  const {temp, env} = await cliEnv();
  await writeTree(temp, {'victim/a.txt': 'a'});
  const report = buildReport([rmRow(path.join(temp, 'victim'))], [], {now: Date.now()});
  await writeReport(temp, {...report, version: 2});
  await assert.rejects(
    execFileP(process.execPath, [SCAN, 'delete', '1'], {env}),
    (e) => e.code === 1 && /report/.test(e.stderr),
  );
  assert.equal(await exists(path.join(temp, 'victim', 'a.txt')), true);
});

test('delete with bad ids exits 1 and deletes nothing', async () => {
  const {temp, env} = await cliEnv();
  await writeTree(temp, {'victim/a.txt': 'a'});
  await writeReport(temp, buildReport([rmRow(path.join(temp, 'victim'))], [], {now: Date.now()}));
  await assert.rejects(execFileP(process.execPath, [SCAN, 'delete', '1;', 'rm'], {env}), (e) => e.code === 1);
  assert.equal(await exists(path.join(temp, 'victim', 'a.txt')), true);
});

test('delete command prints per-id lines, freed bytes per group and free space; old report warns', async () => {
  const {temp, env} = await cliEnv();
  await writeTree(temp, {'one/a.txt': '12345', 'two/b.txt': 'b'});
  const report = buildReport([rmRow(path.join(temp, 'one'), 'safe', {bytes: 5}), rmRow(path.join(temp, 'two'), 'keep')], [],
    {now: Date.now() - 2 * DAY});
  await writeReport(temp, report);
  const {stdout} = await execFileP(process.execPath, [SCAN, 'delete', '1,', '2', '7', '--busy', path.join(temp, 'other')], {env});
  assert.match(stdout, /older than 24 hours/);
  assert.match(stdout, /#1 deleted/);
  assert.match(stdout, /#2 skipped/);
  assert.match(stdout, /#7 skipped: not in the report/);
  assert.match(stdout, /Projects: 5 B/);
  assert.match(stdout, /free of/);
  assert.equal(await exists(path.join(temp, 'one')), false);
  assert.equal(await exists(path.join(temp, 'two', 'b.txt')), true);
});

// Fails only `git worktree remove` with the given stderr; every other command runs for real.
const failRemove = (stderr) => async (cmd, args, opts) =>
  (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove' ? {code: 128, stdout: '', stderr} : noGh(cmd, args, opts));

test('a worktree remove that fails for another reason is reported failed and nothing is force-deleted', async () => {
  const {repo} = await gitRepoWithOrigin();
  const wt = await addWorktree(repo, 'feat/landed', {commit: true, mergeIntoMainAndPush: true});
  const report = buildReport(await git.collect(later(), [repo]), [], {now: Date.now()});
  const stderr = 'fatal: working trees containing submodules cannot be moved or removed\n';
  const [result] = await deleteRows(report, [idOf(report, wt)], later({run: failRemove(stderr)}));
  assert.equal(result.status, 'failed');
  assert.match(result.message, /submodules cannot be moved or removed/);
  assert.equal(result.freed, 0);
  assert.equal(await exists(path.join(wt, 'feat-landed.txt')), true);
  assert.match(gitOut(repo, 'worktree', 'list'), /feat-landed/);
  assert.match(gitOut(repo, 'branch', '--list', 'feat/landed'), /feat\/landed/);
});

test('a worktree remove that fails on a long path falls back to removing the folder', async () => {
  const {repo} = await gitRepoWithOrigin();
  const wt = await addWorktree(repo, 'feat/landed', {commit: true, mergeIntoMainAndPush: true});
  const report = buildReport(await git.collect(later(), [repo]), [], {now: Date.now()});
  const stderr = "error: unable to unlink 'deep/x.js': Filename too long\n";
  const [result] = await deleteRows(report, [idOf(report, wt)], later({run: failRemove(stderr)}));
  assert.equal(result.status, 'deleted', result.message);
  assert.equal(await exists(wt), false);
  assert.doesNotMatch(gitOut(repo, 'worktree', 'list'), /feat-landed/, 'git worktree prune ran');
  assert.equal(gitOut(repo, 'branch', '--list', 'feat/landed').trim(), '');
});

test('a worktree with submodules is skipped without trying to remove it', async () => {
  const {repo} = await gitRepoWithOrigin();
  const wt = await addWorktree(repo, 'feat/sub');
  await writeTree(wt, {'.gitmodules': '[submodule "lib"]\n\tpath = lib\n\turl = ../lib.git\n'});
  gitOut(wt, 'add', '-A');
  gitOut(wt, 'commit', '-q', '-m', 'add submodule config');
  gitOut(repo, 'merge', '-q', '--no-ff', '-m', 'merge feat/sub', 'feat/sub');
  gitOut(repo, 'push', '-q', 'origin', 'main');
  const report = buildReport(await git.collect(later(), [repo]), [], {now: Date.now()});
  const id = idOf(report, wt);
  assert.equal(report.groups[0].rows.find(r => r.id === id).tag, 'safe', 'fixture: safe in the report');
  const calls = [];
  const run = async (cmd, args, opts) => { calls.push(args.join(' ')); return noGh(cmd, args, opts); };
  const [result] = await deleteRows(report, [id], later({run}));
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /submodules/);
  assert.equal(calls.some(c => c.startsWith('worktree remove')), false);
  assert.equal(await exists(path.join(wt, '.gitmodules')), true);
});

test('a row whose path changed kind since the report is skipped', async () => {
  const base = await tmpdir();
  await writeTree(base, {'run.log/inner.txt': 'now a folder', 'cache': 'now a file'});
  const log = path.join(base, 'run.log');
  const cache = path.join(base, 'cache');
  const report = buildReport([
    rmRow(log, 'safe', {reason: {key: 'reason.git_loose_log', params: {}}}),
    rmRow(cache, 'safe'),
  ], [], {now: Date.now()});
  const results = await deleteRows(report, [idOf(report, log), idOf(report, cache)], fakeCtx());
  for (const r of results) {
    assert.equal(r.status, 'skipped');
    assert.match(r.message, /same kind/);
  }
  assert.equal(await exists(path.join(log, 'inner.txt')), true);
  assert.equal(await exists(cache), true);
});

test('a loose log file row is deleted as a file', async () => {
  const base = await tmpdir();
  await writeTree(base, {'run.log': 'abcd'});
  const log = path.join(base, 'run.log');
  const report = buildReport([rmRow(log, 'safe', {reason: {key: 'reason.git_loose_log', params: {}}})], [], {now: Date.now()});
  assert.deepEqual((await deleteRows(report, [1], fakeCtx()))[0], {id: 1, status: 'deleted', freed: 4, message: 'deleted'});
  assert.equal(await exists(log), false);
});

test('paths differing only in case are different on Linux', async () => {
  const base = await tmpdir();
  await writeTree(base, {'dir/a.txt': 'a'});
  const lower = path.join(base, 'dir');
  const upper = path.join(base, 'Dir');
  const report = buildReport([rmRow(upper, 'safe', {action: {type: 'rm', path: lower}})], [], {now: Date.now()});
  // On a case-insensitive disk `Dir` exists; on Linux it does not. Either way the row must not delete `dir`.
  const [result] = await deleteRows(report, [1], fakeCtx({platform: 'linux'}));
  assert.equal(result.status, 'skipped');
  assert.equal(await exists(path.join(lower, 'a.txt')), true);
});
