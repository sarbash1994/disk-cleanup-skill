import fs from 'node:fs/promises';
import path from 'node:path';
import {makeRow, withReal} from '../row.mjs';
import {newestMtime} from '../walk.mjs';

const DAY_MS = 86_400_000;
const NM_SAFE_DAYS = 30;
const BUILD_DIRS = ['.next', 'dist', 'build', 'out', '.turbo', '.parcel-cache', 'coverage'];
// Build outputs change on every build, not on edits, so they do not count as activity.
const RECENCY_SKIP = ['node_modules', '.git', ...BUILD_DIRS];
const WORKSPACE_PARENTS = ['packages', 'apps'];

async function isDir(p) {
  try {
    return (await fs.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Time of the last commit in ms; 0 for a repo without commits or when git fails. */
async function lastCommitMs(ctx, repo) {
  const res = await ctx.run('git', ['log', '-1', '--format=%ct'], {cwd: repo});
  if (res.code !== 0) return 0;
  const secs = Number.parseInt(res.stdout.trim(), 10);
  return Number.isFinite(secs) ? secs * 1000 : 0;
}

async function workspaceNodeModules(repo) {
  const found = [];
  for (const parent of WORKSPACE_PARENTS) {
    let entries;
    try {
      entries = await fs.readdir(path.join(repo, parent), {withFileTypes: true});
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nm = path.join(repo, parent, entry.name, 'node_modules');
      if (await isDir(nm)) found.push(nm);
    }
  }
  return found;
}

async function isFile(p) {
  try {
    return (await fs.lstat(p)).isFile();
  } catch {
    return false;
  }
}

// Case folds: a false match only lists fewer rows.
const fold = (p) => path.resolve(p).toLowerCase();

/** Home or a filesystem root under git: its folders are the user's own, not a project's. */
const isPersonalRoot = (ctx, repo) => fold(repo) === fold(ctx.home) || path.parse(path.resolve(repo)).root === path.resolve(repo);

async function collectRepo(ctx, repo) {
  const rows = [];
  if (isPersonalRoot(ctx, repo)) return rows;
  const name = path.basename(repo);

  const nmDirs = [];
  const topNm = path.join(repo, 'node_modules');
  if (await isDir(topNm)) nmDirs.push(topNm);
  nmDirs.push(...await workspaceNodeModules(repo));

  if (nmDirs.length) {
    const active = Math.max(await lastCommitMs(ctx, repo), await newestMtime(repo, {skip: RECENCY_SKIP}));
    const days = Math.max(0, Math.floor((ctx.now - active) / DAY_MS));
    const old = days >= NM_SAFE_DAYS;
    for (const dir of nmDirs) {
      rows.push(makeRow({
        group: 'projects',
        label: `${name}/${path.relative(repo, dir).split(path.sep).join('/')}`,
        path: dir,
        tag: old ? 'safe' : 'ask',
        reason: {key: old ? 'reason.nm_old' : 'reason.nm_recent', params: {days}},
        action: {type: 'rm', path: dir},
      }));
    }
  }

  // Build outputs are a JS project's; elsewhere `build` or `out` may be the user's own folder.
  if (!await isFile(path.join(repo, 'package.json'))) return rows;
  for (const dirName of BUILD_DIRS) {
    const dir = path.join(repo, dirName);
    if (!await isDir(dir)) continue;
    const res = await ctx.run('git', ['check-ignore', '-q', dirName], {cwd: repo});
    if (res.code !== 0) continue;
    rows.push(makeRow({
      group: 'projects',
      label: `${name}/${dirName}`,
      path: dir,
      tag: 'safe',
      reason: {key: 'reason.build_ignored', params: {}},
      action: {type: 'rm', path: dir},
    }));
  }
  return rows;
}

/**
 * node_modules (top level and workspace packages) and git-ignored build outputs of each repo.
 * None for a repo at home or a filesystem root; build outputs only next to a top-level package.json.
 * @param {object} ctx
 * @param {string[]} repos absolute repo folders
 * @returns {Promise<import('../row.mjs').Row[]>}
 */
export async function collect(ctx, repos) {
  const rows = [];
  for (const repo of repos) rows.push(...await collectRepo(ctx, repo));
  return withReal(rows);
}
