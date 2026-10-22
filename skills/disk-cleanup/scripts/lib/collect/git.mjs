import fs from 'node:fs/promises';
import path from 'node:path';
import {makeRow} from '../row.mjs';
import {newestMtime} from '../walk.mjs';

const DAY_MS = 86_400_000;
const AGENT_DIRS = [['.claude', 'worktrees'], ['.worktrees']];
const LOOSE_FILE = /\.(log|txt)$/i;

// Paths compare case-insensitively everywhere: a false match only keeps more, never deletes more.
const fold = (p) => path.resolve(p).toLowerCase();

function isInside(child, parent) {
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

/**
 * Branch-level rules. `keep` is the first branch-level keep reason
 * (default or current branch, open PR, commits on no remote unless cherry-landed), or null.
 * @param {{prs: object[]|null, base: string, current: string|null}} opts
 * @returns {Promise<{landed:boolean, keep:string|null}>}
 */
export async function classifyBranch(repo, branch, {prs, base, current}, ctx) {
  const ref = `refs/heads/${branch}`;
  const own = prsOf(prs, branch);
  const merged = own.some((p) => p.state === 'MERGED');
  const ancestor = (await ctx.run('git', ['merge-base', '--is-ancestor', ref, base], {cwd: repo})).code === 0;
  const cherry = await ctx.run('git', ['cherry', base, ref], {cwd: repo});
  const cherryLanded = cherry.code === 0 && !cherry.stdout.split(/\r?\n/).some((l) => l.startsWith('+'));
  const landed = merged || ancestor || cherryLanded;

  const defaultBranch = base.slice(base.indexOf('/') + 1);
  let keep = null;
  if (branch === defaultBranch || (current && branch === current)) keep = 'reason.git_current';
  else if (own.some((p) => p.state === 'OPEN')) keep = 'reason.git_open_pr';
  else if (!cherryLanded) {
    const local = await ctx.run('git', ['log', ref, '--not', '--remotes', '--format=%H', '--max-count=1'], {cwd: repo});
    // A failed git log cannot prove the commits are pushed.
    if (local.code !== 0 || local.stdout.trim() !== '') keep = 'reason.git_local_commits';
  }
  return {landed, keep};
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
    info = await classifyBranch(repo, wt.branch, {prs, base, current}, ctx);
    if (info.keep === 'reason.git_current') return result('keep', info.keep);
    if (info.keep === 'reason.git_open_pr') {
      return result('keep', info.keep, {pr: prsOf(prs, wt.branch).find((p) => p.state === 'OPEN').number});
    }
  }

  const status = await ctx.run('git', ['status', '--porcelain'], {cwd: wt.path});
  if (status.code !== 0 || status.stdout.trim() !== '') return result('keep', 'reason.git_dirty');
  if (wt.locked) return result('keep', 'reason.git_locked');
  if (ctx.busy.some((dir) => isInside(dir, wt.path))
      || await newestMtime(wt.path) > ctx.now - DAY_MS) return result('keep', 'reason.git_busy');

  if (!wt.branch) {
    const remote = await ctx.run('git', ['branch', '-r', '--contains', wt.head], {cwd: repo});
    if (remote.code === 0 && remote.stdout.trim() !== '') return result('safe', 'reason.git_detached_pushed');
    return result('keep', 'reason.git_local_commits');
  }

  if (info.keep) return result('keep', info.keep);
  if (info.landed) {
    const mergedPr = prsOf(prs, wt.branch).find((p) => p.state === 'MERGED');
    return result('safe', 'reason.git_landed', mergedPr ? {pr: mergedPr.number} : {});
  }
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
  const res = await ctx.run('gh', ['pr', 'list', '--state', 'all', '--limit', '500', '--json', 'number,state,headRefName'],
    {cwd: repo});
  if (res.code !== 0) return null;
  try {
    const data = JSON.parse(res.stdout);
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
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

  const base = await findBase(repo, ctx);
  if (!base) return [];
  const currentRes = await ctx.run('git', ['branch', '--show-current'], {cwd: repo});
  const current = currentRes.code === 0 && currentRes.stdout.trim() ? currentRes.stdout.trim() : null;
  const prs = await fetchPrs(repo, ctx);
  const opts = {prs, base, current};

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

  const knownNames = new Set(worktrees.map((wt) => path.basename(wt.path).toLowerCase()));
  for (const {dir, entries} of agentDirs) {
    const rel = path.relative(repo, dir).split(path.sep).join('/');
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let reasonKey = null;
      if (entry.isDirectory()) {
        const known = knownNames.has(entry.name.toLowerCase()) || worktrees.some((wt) => isInside(wt.path, full));
        if (!known) reasonKey = 'reason.git_orphan';
      } else if (entry.isFile() && LOOSE_FILE.test(entry.name)) {
        reasonKey = 'reason.git_loose_log';
      }
      if (!reasonKey) continue;
      rows.push(makeRow({
        group: 'projects',
        label: `${name}/${rel}/${entry.name}`,
        path: full,
        tag: 'safe',
        reason: {key: reasonKey, params: {}},
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
  let count = 0;
  for (const line of res.stdout.split(/\r?\n/)) {
    const branch = line.trim().replace(/^refs\/heads\//, '');
    if (!branch || checkedOut.has(branch)) continue;
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
