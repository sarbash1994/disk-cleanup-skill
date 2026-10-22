import fs from 'node:fs/promises';
import path from 'node:path';
import {makeRow, withReal} from '../row.mjs';

async function isDir(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** The first non-empty line of a successful command, or null. Runs in home: a project folder may pin another tool version. */
async function folderFrom(ctx, cmd, args) {
  const res = await ctx.run(cmd, args, {cwd: ctx.home});
  if (res.code !== 0) return null;
  const line = res.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line && path.isAbsolute(line) ? line : null;
}

/** Package managers with a cache command: how to find the folder and how to clean it on `platform`. */
function cacheTools(platform) {
  const win = platform === 'win32';
  const launcher = (name) => (win ? `${name}.cmd` : name);
  const python = win ? ['py'] : ['python3'];
  return [
    {label: 'npm cache', cmd: launcher('npm'), where: ['config', 'get', 'cache'], clean: ['cache', 'clean', '--force'], reason: 'reason.cache_clean'},
    {label: 'pnpm cache', cmd: launcher('pnpm'), where: ['store', 'path'], clean: ['store', 'prune'], reason: 'reason.pnpm_prune'},
    {label: 'yarn cache', cmd: launcher('yarn'), where: ['cache', 'dir'], clean: ['cache', 'clean'], reason: 'reason.cache_clean'},
    {label: 'pip cache', cmd: python[0], where: ['-m', 'pip', 'cache', 'dir'], clean: ['-m', 'pip', 'cache', 'purge'], reason: 'reason.cache_clean'},
  ];
}

/**
 * Every clean command a cache row can carry on `platform`; delete runs no other command.
 * @returns {{cmd:string, args:string[]}[]}
 */
export function cleanCommands(platform) {
  return cacheTools(platform).map((tool) => ({cmd: tool.cmd, args: tool.clean}));
}

/**
 * One row per package manager cache that exists on this machine.
 * A tool that is missing or fails is skipped.
 * @returns {Promise<import('../row.mjs').Row[]>}
 */
export async function collect(ctx) {
  const tools = cacheTools(ctx.platform);

  const rows = [];
  const tasks = tools.map(async (tool) => {
    const dir = await folderFrom(ctx, tool.cmd, tool.where);
    if (!dir || !(await isDir(dir))) return null;
    return makeRow({
      group: 'caches',
      label: tool.label,
      path: dir,
      tag: 'safe',
      reason: {key: tool.reason, params: {}},
      action: {type: 'cmd', cmd: tool.cmd, args: tool.clean},
    });
  });

  const bunRoot = ctx.env.BUN_INSTALL || path.join(ctx.home, '.bun');
  const bunDir = path.join(bunRoot, 'install', 'cache');
  tasks.push((async () => (await isDir(bunDir)
    ? makeRow({
      group: 'caches',
      label: 'bun cache',
      path: bunDir,
      tag: 'safe',
      reason: {key: 'reason.cache_clean', params: {}},
      action: {type: 'rm', path: bunDir},
    })
    : null))());

  for (const row of await Promise.all(tasks)) if (row) rows.push(row);
  return withReal(rows);
}
