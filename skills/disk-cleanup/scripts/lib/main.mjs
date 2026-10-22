import path from 'node:path';
import {EN, loadStrings, t} from './strings.mjs';
import {fixedDrives, makeContext} from './ctx.mjs';
import {measureSize} from './walk.mjs';
import {listDisks} from './disks.mjs';
import {defaultRoots, findRepos} from './discover.mjs';
import {buildReport, formatBytes, renderHtml, renderSummary} from './report.mjs';
import {deleteRows, isValidReport, parseIds} from './delete.mjs';
import {UnsafePathError, prepareDir, readOwnFile, reportDir, writeOwnFile} from './outdir.mjs';
import {parseFlags} from './flags.mjs';
import * as projects from './collect/projects.mjs';
import * as git from './collect/git.mjs';
import * as caches from './collect/caches.mjs';
import * as browsers from './collect/browsers.mjs';
import * as agents from './collect/agents.mjs';
import * as heavy from './collect/heavy.mjs';

const USAGE = 'Usage: node scan.mjs <strings|report|delete>';
const MEASURE_PARALLEL = 4;
const MEASURE_TIMEOUT_MS = 60_000;
const DAY_MS = 86_400_000;

const progress = (group, n, total) => process.stderr.write(`progress: ${group} ${n}/${total}\n`);

/** Measures rows with unknown size and a path, a few at a time; a timeout leaves null. */
async function measureRows(rows) {
  const todo = rows.filter((r) => r.bytes === null && r.path);
  const totals = {};
  const done = {};
  for (const r of todo) totals[r.group] = (totals[r.group] ?? 0) + 1;
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const row = todo[next++];
      row.bytes = await measureSize(row.path, {deadline: Date.now() + MEASURE_TIMEOUT_MS});
      done[row.group] = (done[row.group] ?? 0) + 1;
      progress(row.group, done[row.group], totals[row.group]);
    }
  }
  await Promise.all(Array.from({length: Math.min(MEASURE_PARALLEL, todo.length)}, worker));
}

/**
 * Runs each collector in turn; one that throws yields no rows and one stderr line, the rest still run.
 * @param {[string, () => Promise<object[]>][]} collectors name and collector
 */
export async function collectAll(collectors, warn = (line) => process.stderr.write(line + '\n')) {
  const rows = [];
  for (const [name, collect] of collectors) {
    try {
      rows.push(...await collect());
    } catch (err) {
      warn(`warning: the ${name} collector failed and its rows are left out: ${err?.message ?? err}`);
    }
  }
  return rows;
}

async function report(flags) {
  const ctx = makeContext({busy: flags.busy ?? [], drives: await fixedDrives()});
  const strings = loadStrings(flags.strings?.[0]);
  const roots = flags.roots?.length ? flags.roots : await defaultRoots(ctx);
  const repos = await findRepos(roots, ctx);
  progress('repos', repos.length, repos.length);

  const rows = await collectAll([
    ['projects', () => projects.collect(ctx, repos)],
    ['git', () => git.collect(ctx, repos)],
    ['caches', () => caches.collect(ctx)],
    ['browsers', () => browsers.collect(ctx)],
    ['agents', () => agents.collect(ctx)],
    ['heavy', () => heavy.collect(ctx)],
  ]);
  await measureRows(rows);

  const disks = await listDisks(ctx, [...roots, ctx.home, ctx.tmp]);
  const result = buildReport(rows, disks, {now: Date.now()});
  const dir = reportDir();
  const jsonFile = path.join(dir, 'report.json');
  const htmlFile = path.join(dir, 'report.html');
  try {
    await prepareDir(dir);
    await writeOwnFile(jsonFile, JSON.stringify(result, null, 2));
    await writeOwnFile(htmlFile, renderHtml(result, strings));
  } catch (err) {
    if (err instanceof UnsafePathError) return fail(t(EN, 'unsafe_path', {file: err.path}));
    throw err;
  }
  process.stdout.write(`${renderSummary(result, strings, {top: 5})}\n\n${htmlFile}\n${jsonFile}\n`);
}

const fail = (text) => {
  process.stderr.write(text + '\n');
  process.exit(1);
};

/** `delete <ids...> [--busy <dir>...]`: ids are every argument before the first flag, joined with spaces. */
async function del(args) {
  const firstFlag = args.findIndex((a) => a.startsWith('--'));
  const flags = parseFlags(args);
  let ids;
  try {
    ids = parseIds((firstFlag < 0 ? args : args.slice(0, firstFlag)).join(' '));
  } catch (err) {
    return fail(t(EN, 'delete.bad_ids', {error: err.message}));
  }

  const file = path.join(reportDir(), 'report.json');
  let data;
  try {
    data = JSON.parse(await readOwnFile(file));
  } catch (err) {
    if (err instanceof UnsafePathError) return fail(t(EN, 'unsafe_path', {file: err.path}));
    return fail(t(EN, err.code === 'ENOENT' ? 'delete.no_report' : 'delete.bad_report', {file}));
  }
  if (!isValidReport(data)) return fail(t(EN, 'delete.bad_report', {file}));
  if (typeof data.createdAt !== 'number' || Date.now() - data.createdAt > DAY_MS) {
    process.stdout.write(t(EN, 'delete.old_report') + '\n');
  }

  const ctx = makeContext({busy: flags.busy ?? [], drives: []});
  const results = await deleteRows(data, ids, ctx);
  const groupOf = new Map(data.groups.flatMap((g) => g.rows.map((r) => [r.id, g.group])));
  const freed = new Map();
  for (const r of results) {
    process.stdout.write(`#${r.id} ${r.status}: ${r.message}\n`);
    if (r.status === 'deleted') freed.set(groupOf.get(r.id), (freed.get(groupOf.get(r.id)) ?? 0) + r.freed);
  }
  if (freed.size) {
    process.stdout.write(`\n${t(EN, 'delete.freed')}\n`);
    for (const [group, bytes] of freed) process.stdout.write(`${t(EN, `group.${group}`)}: ${formatBytes(bytes)}\n`);
  }
  const mounts = (data.disks ?? []).map((d) => d.mount).filter((m) => typeof m === 'string');
  const disks = await listDisks(ctx, mounts.length ? mounts : [ctx.home, ctx.tmp]);
  process.stdout.write(`\n${t(EN, 'delete.disks')}\n`);
  for (const d of disks) {
    process.stdout.write(`${d.mount}: ${t(EN, 'disk_free', {free: formatBytes(d.free), total: formatBytes(d.total)})}\n`);
  }
}

/** The CLI: `strings | report | delete`; `args` are the arguments after the script path. */
export async function main([command, ...rest]) {
  if (command === 'strings') {
    process.stdout.write(JSON.stringify(EN, null, 2) + '\n');
  } else if (command === 'report') {
    await report(parseFlags(rest));
  } else if (command === 'delete') {
    await del(rest);
  } else {
    process.stderr.write(USAGE + '\n');
    process.exit(2);
  }
}
