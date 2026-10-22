import fs from 'node:fs/promises';
import path from 'node:path';
import {makeRow} from '../row.mjs';
import {newestMtimeInfo} from '../walk.mjs';

const DAY_MS = 86_400_000;
const AGENT_DIRS = [['.claude', 'worktrees'], ['.worktrees']];
const LOOSE_FILE = /\.(log|txt)$/i;

// Paths compare case-insensitively everywhere: a false match only keeps more, never deletes more.
const fold = (p) => path.resolve(p).toLowerCase();

export function isInside(child, parent) {
  const rel = path.relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Entries of `git worktree list --porcelain`, the main checkout first.
 * @returns {Promise<{path:string, head:string, branch:string|null, locked:boolean}[]|null>} null when git fails
 */
export async function listWorktrees(repo, ctx) {
  const res = await ctx.run('git', ['worktree', 'list', '--porcelain'], {cwd: repo});
  if (res.code !== 0) return null;
  const list = [];
  let wt = null;
  for (const line of res.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      wt = {path: path.resolve(line.slice('worktree '.length)), head: '', branch: null, locked: false};
      list.push(wt);
    } else if (!wt) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      wt.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      wt.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'locked' || line.startsWith('locked ')) {
      wt.locked = true;
    }
  }
  return list;
}

const prsOf = (prs, branch) => (prs ?? []).filter((p) => p && p.headRefName === branch);
const SHA = /^[0-9a-f]{7,64}$/i;

/**
 * The MERGED PR of `branch` whose head is the local tip or a descendant of it, or null.
 * A PR head that is not present locally proves nothing.
 */
async function verifiedMergedPr(repo, branch, prs, ctx) {
  const merged = prsOf(prs, branch).filter((p) => p.state === 'MERGED' && typeof p.headRefOid === 'string' && SHA.test(p.headRefOid));
  if (!merged.length) return null;
  const tipRes = await ctx.run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {cwd: repo});
  const tip = tipRes.code === 0 ? tipRes.stdout.trim() : '';
  if (!tip) return null;
  for (const pr of merged) {
    if (pr.headRefOid.toLowerCase() === tip.toLowerCase()) return pr;
    const res = await ctx.run('git', ['merge-base', '--is-ancestor', tip, pr.headRefOid], {cwd: repo});
    if (res.code === 0) return pr;
  }
  return null;
}

async function classify(repo, branch, {prs, base, current}, ctx) {
  const ref = `refs/heads/${branch}`;
  const own = prsOf(prs, branch);
  const mergedPr = await verifiedMergedPr(repo, branch, prs, ctx);
  const ancestor = (await ctx.run('git', ['merge-base', '--is-ancestor', ref, base], {cwd: repo})).code === 0;
  const cherry = await ctx.run('git', ['cherry', base, ref], {cwd: repo});
  const cherryLanded = cherry.code === 0 && !cherry.stdout.split(/\r?\n/).some((l) => l.startsWith('+'));
  const landed = Boolean(mergedPr) || ancestor || cherryLanded;

  const defaultBranch = base.slice(base.indexOf('/') + 1);
  let keep = null;
  if (branch === defaultBranch || (current && branch === current)) keep = 'reason.git_current';
  else if (own.some((p) => p.state === 'OPEN')) keep = 'reason.git_open_pr';
  else if (!cherryLanded) {
    const local = await ctx.run('git', ['log', ref, '--not', '--remotes', '--format=%H', '--max-count=1'], {cwd: repo});
    // A failed git log cannot prove the commits are pushed.
    if (local.code !== 0 || local.stdout.trim() !== '') keep = 'reason.git_local_commits';
  }
  return {landed, keep, mergedPr};
}

/**
 * Branch-level rules. `keep` is the first branch-level keep reason
 * (default or current branch, open PR, commits on no remote unless cherry-landed), or null.
 * A MERGED PR lands the branch only when its headRefOid is the local tip or descends from it.
 * @param {{prs: object[]|null, base: string, current: string|null}} opts
 * @returns {Promise<{landed:boolean, keep:string|null}>}
 */
export async function classifyBranch(repo, branch, opts, ctx) {
  const {landed, keep} = await classify(repo, branch, opts, ctx);
  return {landed, keep};
}

/**
 * In use: a ctx.busy dir equal to or inside `dir`, a file changed in the last 24 hours,
 * or a recency scan that could not finish (limit `ctx.mtimeLimit`, default of newestMtimeInfo).
 */
async function inUse(dir, ctx) {
  if (ctx.busy.some((b) => isInside(b, dir))) return true;
  const {newest, complete} = await newestMtimeInfo(dir, {limit: ctx.mtimeLimit});
  return !complete || newest > ctx.now - DAY_MS;
}

/**
 * Every keep / landed / ask rule for one linked worktree; used by the report and again before deletion.
 * @param {{path:string, head:string, branch:string|null, locked:boolean}} wt
 * @param {{prs: object[]|null, base: string, current: string|null}} opts
 * @returns {Promise<{tag:'safe'|'ask'|'keep', reasonKey:string, params:object}>}
 */
export async function checkWorktree(repo, wt, {prs, base, current}, ctx) {
  const result = (tag, reasonKey, params = {}) => ({tag, reasonKey, params});
  let info = null;
  if (wt.branch) {
    info = await classify(repo, wt.branch, {prs, base, current}, ctx);
    if (info.keep === 'reason.git_current') return result('keep', info.keep);
    if (info.keep === 'reason.git_open_pr') {
      return result('keep', info.keep, {pr: prsOf(prs, wt.branch).find((p) => p.state === 'OPEN').number});
    }
  }

  const status = await ctx.run('git', ['status', '--porcelain'], {cwd: wt.path});
  if (status.code !== 0 || status.stdout.trim() !== '') return result('keep', 'reason.git_dirty');
  if (wt.locked) return result('keep', 'reason.git_locked');
  if (await inUse(wt.path, ctx)) return result('keep', 'reason.git_busy');

  if (!wt.branch) {
    const remote = await ctx.run('git', ['branch', '-r', '--contains', wt.head], {cwd: repo});
    if (remote.code === 0 && remote.stdout.trim() !== '') return result('safe', 'reason.git_detached_pushed');
    return result('keep', 'reason.git_local_commits');
  }

  if (info.keep) return result('keep', info.keep);
  if (info.landed) return result('safe', 'reason.git_landed', info.mergedPr ? {pr: info.mergedPr.number} : {});
  if (prs === null) return result('ask', 'reason.git_no_pr_data');
  return result('ask', 'reason.git_unmerged');
}


/** `origin/HEAD` target, else origin/main, else origin/master; null without such a remote branch. */
async function findBase(repo, ctx) {
  const head = await ctx.run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {cwd: repo});
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const name of ['main', 'master']) {
    const res = await ctx.run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`], {cwd: repo});
    if (res.code === 0) return `origin/${name}`;
  }
  return null;
}

async function fetchPrs(repo, ctx) {
  const res = await ctx.run('gh', ['pr', 'list', '--state', 'all', '--limit', '500', '--json', 'number,state,headRefName,headRefOid'],
    {cwd: repo});
  if (res.code !== 0) return null;
  try {
    const data = JSON.parse(res.stdout);
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * What the branch rules of one repo need: the default remote branch, the current branch and PR data.
 * Used by the report and again before deletion.
 * @returns {Promise<{prs: object[]|null, base: string, current: string|null}|null>} null without an origin default branch
 */
export async function repoContext(repo, ctx) {
  const base = await findBase(repo, ctx);
  if (!base) return null;
  const currentRes = await ctx.run('git', ['branch', '--show-current'], {cwd: repo});
  const current = currentRes.code === 0 && currentRes.stdout.trim() ? currentRes.stdout.trim() : null;
  const prs = await fetchPrs(repo, ctx);
  return {prs, base, current};
}

/** A folder in an agent worktree folder that git lists as a worktree: same name, or a worktree lives inside it. */
export function isKnownWorktree(dir, worktrees) {
  const name = path.basename(dir).toLowerCase();
  return worktrees.some((wt) => path.basename(wt.path).toLowerCase() === name || isInside(wt.path, dir));
}

/** The repo whose `.claude/worktrees/` or `.worktrees/` folder directly holds `entry`, else null. */
export function agentDirRepo(entry) {
  for (const parts of AGENT_DIRS) {
    let dir = path.dirname(path.resolve(entry));
    let match = true;
    for (let i = parts.length - 1; i >= 0 && match; i--) {
      match = path.basename(dir).toLowerCase() === parts[i];
      dir = path.dirname(dir);
    }
    if (match) return dir;
  }
  return null;
}

/**
 * Rules for one entry of an agent worktree folder that git does not list as a worktree;
 * used by the report and again before deletion. Links are never candidates.
 * @returns {Promise<{tag:'safe'|'ask'|'keep', reasonKey:string, params:object}|null>} null when the entry is no candidate
 */
export async function checkOrphan(entry, ctx) {
  const result = (tag, reasonKey) => ({tag, reasonKey, params: {}});
  let st;
  try {
    st = await fs.lstat(entry);
  } catch {
    return null;
  }
  if (st.isDirectory()) {
    if (await inUse(entry, ctx)) return result('keep', 'reason.git_busy');
    // A clone or a moved worktree may hold commits, stashes or changes.
    if (await exists(path.join(entry, '.git'))) return result('ask', 'reason.git_orphan_repo');
    return result('safe', 'reason.git_orphan');
  }
  if (st.isFile() && LOOSE_FILE.test(path.basename(entry))) return result('safe', 'reason.git_loose_log');
  return null;
}

/** A linked worktree has its own git dir apart from the common one; its main checkout is scanned instead. */
async function isLinkedWorktree(repo, ctx) {
  const res = await ctx.run('git', ['rev-parse', '--git-dir', '--git-common-dir'], {cwd: repo});
  if (res.code !== 0) return true;
  const [gitDir, commonDir] = res.stdout.split(/\r?\n/).map((s) => s.trim());
  return !gitDir || !commonDir || fold(path.resolve(repo, gitDir)) !== fold(path.resolve(repo, commonDir));
}

async function readDir(dir) {
  try {
    return await fs.readdir(dir, {withFileTypes: true});
  } catch {
    return [];
  }
}

async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function collectRepo(ctx, repo) {
  if (await isLinkedWorktree(repo, ctx)) return [];
  const worktrees = await listWorktrees(repo, ctx);
  if (!worktrees) return [];
  const linked = worktrees.slice(1);
  const agentDirs = [];
  for (const parts of AGENT_DIRS) {
    const dir = path.join(repo, ...parts);
    const entries = await readDir(dir);
    if (entries.length) agentDirs.push({dir, entries});
  }
  if (!linked.length && !agentDirs.length) return [];

  const opts = await repoContext(repo, ctx);
  if (!opts) return [];

  const name = path.basename(repo);
  const rows = [];
  for (const wt of linked) {
    if (!await exists(wt.path)) continue;
    const check = await checkWorktree(repo, wt, opts, ctx);
    const label = isInside(wt.path, repo)
      ? `${name}/${path.relative(repo, wt.path).split(path.sep).join('/')}`
      : `${name} @ ${path.basename(wt.path)}`;
    rows.push(makeRow({
      group: 'projects',
      label,
      path: wt.path,
      tag: check.tag,
      reason: {key: check.reasonKey, params: check.params},
      action: {type: 'worktree', repo, path: wt.path, branch: wt.branch},
    }));
  }

  for (const {dir, entries} of agentDirs) {
    const rel = path.relative(repo, dir).split(path.sep).join('/');
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && isKnownWorktree(full, worktrees)) continue;
      const check = await checkOrphan(full, ctx);
      if (!check) continue;
      rows.push(makeRow({
        group: 'projects',
        label: `${name}/${rel}/${entry.name}`,
        path: full,
        tag: check.tag,
        reason: {key: check.reasonKey, params: check.params},
        action: {type: 'rm', path: full},
      }));
    }
  }

  const count = await countLandedBranches(repo, worktrees, opts, ctx);
  if (count > 0) {
    rows.push(makeRow({
      group: 'projects',
      label: name,
      path: repo,
      bytes: 0,
      tag: 'show',
      reason: {key: 'reason.git_branch_count', params: {count}},
    }));
  }
  return rows;
}

/** Local branches with no worktree that are landed and have no keep reason. */
async function countLandedBranches(repo, worktrees, opts, ctx) {
  const res = await ctx.run('git', ['for-each-ref', '--format=%(refname)', 'refs/heads/'], {cwd: repo});
  if (res.code !== 0) return 0;
  const checkedOut = new Set(worktrees.map((wt) => wt.branch).filter(Boolean));
  const names = (text) => text.split(/\r?\n/).map((l) => l.trim().replace(/^refs\/heads\//, '')).filter(Boolean);
  const branches = names(res.stdout).filter((b) => !checkedOut.has(b));
  // One call finds every ancestor-landed branch; only the rest need the per-branch checks.
  const merged = await ctx.run('git', ['branch', '--merged', opts.base, '--format=%(refname)'], {cwd: repo});
  const ancestors = new Set(merged.code === 0 ? names(merged.stdout) : []);
  const defaultBranch = opts.base.slice(opts.base.indexOf('/') + 1);
  let count = 0;
  for (const branch of branches) {
    if (ancestors.has(branch)) {
      // An ancestor is also cherry-landed, so only the current/default and open-PR keeps apply.
      const open = (opts.prs ?? []).some((p) => p && p.headRefName === branch && p.state === 'OPEN');
      if (branch !== defaultBranch && branch !== opts.current && !open) count++;
      continue;
    }
    const info = await classifyBranch(repo, branch, opts, ctx);
    if (info.landed && !info.keep) count++;
  }
  return count;
}

/**
 * Linked worktrees, orphaned folders and loose logs in `.claude/worktrees/` and `.worktrees/`,
 * and a count of landed local branches, for repos that have worktrees. No `git fetch`.
 * @param {object} ctx
 * @param {string[]} repos absolute repo folders
 * @returns {Promise<import('../row.mjs').Row[]>}
 */
export async function collect(ctx, repos) {
  const rows = [];
  for (const repo of repos) rows.push(...await collectRepo(ctx, repo));
  return rows;
}
