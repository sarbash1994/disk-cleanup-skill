import fs from 'node:fs/promises';
import path from 'node:path';
import {EN, t} from './strings.mjs';
import {measureSize} from './walk.mjs';
import {agentDirRepo, checkOrphan, checkWorktree, isKnownWorktree, listWorktrees, repoContext} from './collect/git.mjs';
import {checkAgentTemp} from './collect/agents.mjs';

const MAX_IDS = 10_000;
const CMD_TIMEOUT_MS = 600_000;
const FETCH_TIMEOUT_MS = 120_000;
const MEASURE_TIMEOUT_MS = 120_000;

/**
 * Row numbers from text like `1, 3, 5-8`: commas or spaces between items, sorted, duplicates removed.
 * @returns {number[]}
 * @throws {Error} on anything else
 */
export function parseIds(text) {
  const ids = new Set();
  const parts = String(text).trim().split(',');
  for (const part of parts) {
    const tokens = part.trim().split(/\s+/);
    if (tokens.length === 1 && tokens[0] === '') throw new Error(`empty item in "${text}"`);
    for (const token of tokens) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(token);
      if (!m) throw new Error(`"${token}" is not a number or a range`);
      const from = Number(m[1]);
      const to = m[2] === undefined ? from : Number(m[2]);
      if (from < 1 || to < from) throw new Error(`"${token}" is not a valid range`);
      if (to - from + ids.size >= MAX_IDS) throw new Error(`more than ${MAX_IDS} rows`);
      for (let id = from; id <= to; id++) ids.add(id);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

const msg = (key, params) => t(EN, key, params);
const outcome = (id, status, message, freed = 0) => ({id, status, freed, message});
// Case folds only where the file system usually ignores case; on Linux Feat and feat are two folders.
const foldsCase = (platform) => platform === 'win32' || platform === 'darwin';
const exactPath = (a, b) => path.resolve(a) === path.resolve(b);
const samePath = (a, b, platform) =>
  exactPath(a, b) || (foldsCase(platform) && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase());
// Only loose logs are files; every other rm or worktree row is a folder.
const kindOf = (row) => (row.reason?.key === 'reason.git_loose_log' ? 'file' : 'dir');
// git fails on paths longer than the OS allows (MAX_PATH on Windows); only then is a direct removal the fallback.
const LONG_PATH = /filename too long|name too long/i;
// Fresh `safe` may go; fresh `ask` only when the user saw `ask` too; anything else changed under them.
const stillDeletable = (fresh, seen) => fresh === 'safe' || (fresh === 'ask' && seen === 'ask');
const changed = (check) => msg('delete.changed', {reason: msg(check.reasonKey, check.params)});

async function lstatOrNull(p) {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

/**
 * Refusal message when `p` is missing, a symlink or junction, or no longer the expected kind
 * (`'file'` or `'dir'`); null when it may go.
 */
async function refusal(p, kind) {
  const st = await lstatOrNull(p);
  if (!st) return msg('delete.missing');
  if (st.isSymbolicLink()) return msg('delete.link');
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) return msg('delete.kind_changed');
  return null;
}

/** Bytes of a file or a folder (links not followed); 0 when missing or the measurement ran out of time. */
async function sizeOf(p) {
  const st = await lstatOrNull(p);
  if (!st || st.isSymbolicLink()) return 0;
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  return (await measureSize(p, {deadline: Date.now() + MEASURE_TIMEOUT_MS})) ?? 0;
}

/** Checks the path is still a real file or folder right before removing it; returns a refusal or null. */
async function removePath(p, kind) {
  const refused = await refusal(p, kind);
  if (refused) return refused;
  await fs.rm(p, {recursive: true, force: false, maxRetries: 3});
  return null;
}

const lastLine = (text) => String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';

/** The same rule the report used for this rm row, run again now; a skip message or null. */
async function recheckRm(row, ctx) {
  const p = row.action.path;
  if (row.group === 'agents') {
    const check = await checkAgentTemp(p, ctx);
    return stillDeletable(check.tag, row.tag) ? null : changed(check);
  }
  const repo = agentDirRepo(p);
  if (row.group === 'projects' && repo) {
    const worktrees = await listWorktrees(repo, ctx);
    if (!worktrees) return msg('delete.git_failed');
    if (isKnownWorktree(p, worktrees)) return msg('delete.now_worktree');
    const check = await checkOrphan(p, ctx);
    if (!check) return msg('delete.not_file_or_dir');
    return stillDeletable(check.tag, row.tag) ? null : changed(check);
  }
  return null;
}

async function deleteRm(row, ctx) {
  const p = row.action.path;
  const kind = kindOf(row);
  const refused = await refusal(p, kind);
  if (refused) return outcome(row.id, 'skipped', refused);
  const skip = await recheckRm(row, ctx);
  if (skip) return outcome(row.id, 'skipped', skip);
  const freed = await sizeOf(p);
  const refusedNow = await removePath(p, kind);
  if (refusedNow) return outcome(row.id, 'skipped', refusedNow);
  return outcome(row.id, 'deleted', msg('delete.deleted'), freed);
}

async function runCmd(row, ctx) {
  const {cmd, args} = row.action;
  const before = row.path ? await sizeOf(row.path) : 0;
  const res = await ctx.run(cmd, args, {timeoutMs: CMD_TIMEOUT_MS});
  if (res.code !== 0) {
    const error = lastLine(res.stderr) || (res.code === null ? msg('delete.cmd_unavailable') : msg('delete.cmd_exit', {code: res.code}));
    return outcome(row.id, 'failed', msg('delete.failed', {error}));
  }
  const freed = row.path ? Math.max(0, before - await sizeOf(row.path)) : 0;
  return outcome(row.id, 'deleted', msg('delete.deleted'), freed);
}

/** Finds the row's worktree in a fresh git listing and runs checkWorktree on it; {wt} or {skip}. */
async function recheckWorktree(row, opts, ctx) {
  const {repo, path: wtPath, branch} = row.action;
  const list = await listWorktrees(repo, ctx);
  if (!list) return {skip: msg('delete.git_failed')};
  // The first entry is the main checkout, never a candidate. An exact match wins over a case-folded one.
  const linked = list.slice(1);
  const wt = linked.find((w) => exactPath(w.path, wtPath)) ?? linked.find((w) => samePath(w.path, wtPath, ctx.platform));
  if (!wt) return {skip: msg('delete.not_worktree')};
  if ((wt.branch ?? null) !== (branch ?? null)) return {skip: msg('delete.branch_changed')};
  const check = await checkWorktree(repo, wt, opts, ctx);
  if (!stillDeletable(check.tag, row.tag)) return {skip: changed(check)};
  return {wt};
}

async function deleteWorktree(row, ctx, repoState) {
  const {repo} = row.action;
  const key = path.resolve(repo).toLowerCase();
  if (!repoState.has(key)) {
    // A failed fetch leaves older remote refs, which can only make fewer branches look landed.
    await ctx.run('git', ['fetch', '--prune', 'origin'], {cwd: repo, timeoutMs: FETCH_TIMEOUT_MS});
    repoState.set(key, await repoContext(repo, ctx));
  }
  const opts = repoState.get(key);
  if (!opts) return outcome(row.id, 'skipped', msg('delete.no_base'));

  const first = await recheckWorktree(row, opts, ctx);
  if (first.skip) return outcome(row.id, 'skipped', first.skip);
  // From here on only git's own path is used: for the check, the removal and the fallback.
  const {wt} = first;
  const refused = await refusal(wt.path, 'dir');
  if (refused) return outcome(row.id, 'skipped', refused);
  // Submodules hold their own commits and stashes under .git/worktrees/<id>/modules; git refuses them too.
  if (await lstatOrNull(path.join(wt.path, '.gitmodules'))) return outcome(row.id, 'skipped', msg('delete.submodules'));
  const freed = await sizeOf(wt.path);
  const removed = await ctx.run('git', ['worktree', 'remove', wt.path], {cwd: repo, timeoutMs: CMD_TIMEOUT_MS});
  if (removed.code !== 0) {
    const error = lastLine(removed.stderr) || msg('delete.cmd_exit', {code: removed.code});
    if (!LONG_PATH.test(removed.stderr)) return outcome(row.id, 'failed', msg('delete.failed', {error}));
    // Long paths on Windows defeat git; one more clean check, then remove the folder directly.
    const again = await recheckWorktree(row, opts, ctx);
    if (again.skip) return outcome(row.id, 'skipped', again.skip);
    const refusedNow = await removePath(wt.path, 'dir');
    if (refusedNow) return outcome(row.id, 'skipped', refusedNow);
    await ctx.run('git', ['worktree', 'prune'], {cwd: repo});
  }
  let message = msg('delete.deleted');
  if (wt.branch) {
    const del = await ctx.run('git', ['branch', '-D', wt.branch], {cwd: repo});
    if (del.code !== 0) message = msg('delete.branch_kept', {branch: wt.branch, error: lastLine(del.stderr)});
  }
  return outcome(row.id, 'deleted', message, freed);
}

async function deleteOne(row, id, ctx, repoState) {
  if (!row) return outcome(id, 'skipped', msg('delete.not_in_report'));
  if (row.tag !== 'safe' && row.tag !== 'ask') return outcome(id, 'skipped', msg('delete.not_deletable', {tag: row.tag}));
  const action = row.action ?? {type: 'none'};
  if (row.path && !await lstatOrNull(row.path)) return outcome(id, 'skipped', msg('delete.missing'));
  if (action.type === 'cmd') return runCmd(row, ctx);
  // The folder deleted must be the one the user saw in the report.
  if ((action.type === 'rm' || action.type === 'worktree') && row.path && action.path && samePath(row.path, action.path, ctx.platform)) {
    return action.type === 'rm' ? deleteRm(row, ctx) : deleteWorktree(row, ctx, repoState);
  }
  return outcome(id, 'skipped', msg('delete.no_action'));
}

/**
 * Deletes the chosen rows one at a time, each checked again against the disk and git first.
 * Remote branches are never deleted.
 * @param {{groups: {rows: import('./row.mjs').Row[]}[]}} report
 * @param {number[]} ids
 * @returns {Promise<{id:number, status:'deleted'|'skipped'|'failed', freed:number, message:string}[]>}
 */
export async function deleteRows(report, ids, ctx) {
  const rows = new Map(report.groups.flatMap((g) => g.rows).map((r) => [r.id, r]));
  const repoState = new Map();
  const results = [];
  for (const id of ids) {
    try {
      results.push(await deleteOne(rows.get(id), id, ctx, repoState));
    } catch (err) {
      results.push(outcome(id, 'failed', msg('delete.failed', {error: err?.message ?? String(err)})));
    }
  }
  return results;
}
