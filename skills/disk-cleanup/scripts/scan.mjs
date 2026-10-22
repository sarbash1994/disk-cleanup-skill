#!/usr/bin/env node
// Before any fs work: Node's default pool of 4 threads caps every directory walk.
process.env.UV_THREADPOOL_SIZE ??= '16';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EN, loadStrings, t} from './lib/strings.mjs';
import {makeContext} from './lib/ctx.mjs';
import {measureSize} from './lib/walk.mjs';
import {listDisks} from './lib/disks.mjs';
import {defaultRoots, findRepos} from './lib/discover.mjs';
import {buildReport, formatBytes, renderHtml, renderSummary} from './lib/report.mjs';
import {deleteRows, parseIds} from './lib/delete.mjs';
import {parseFlags} from './lib/flags.mjs';
import * as projects from './lib/collect/projects.mjs';
import * as git from './lib/collect/git.mjs';
import * as caches from './lib/collect/caches.mjs';
import * as browsers from './lib/collect/browsers.mjs';
import * as agents from './lib/collect/agents.mjs';
import * as heavy from './lib/collect/heavy.mjs';

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

async function report(flags) {
  const ctx = makeContext({busy: flags.busy ?? []});
  const strings = loadStrings(flags.strings?.[0]);
  const roots = flags.roots?.length ? flags.roots : await defaultRoots(ctx);
  const repos = await findRepos(roots, ctx);
  progress('repos', repos.length, repos.length);

  const rows = [
    ...await projects.collect(ctx, repos),
    ...await git.collect(ctx, repos),
    ...await caches.collect(ctx),
    ...await browsers.collect(ctx),
    ...await agents.collect(ctx),
    ...await heavy.collect(ctx),
  ];
  await measureRows(rows);

  const disks = await listDisks(ctx, [...roots, ctx.home, ctx.tmp]);
  const result = buildReport(rows, disks, {now: Date.now()});
  const dir = path.join(os.tmpdir(), 'disk-cleanup');
  await fs.mkdir(dir, {recursive: true});
  const jsonFile = path.join(dir, 'report.json');
  const htmlFile = path.join(dir, 'report.html');
  await fs.writeFile(jsonFile, JSON.stringify(result, null, 2));
  await fs.writeFile(htmlFile, renderHtml(result, strings));
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

  const file = path.join(os.tmpdir(), 'disk-cleanup', 'report.json');
  let data;
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    return fail(t(EN, err.code === 'ENOENT' ? 'delete.no_report' : 'delete.bad_report', {file}));
  }
  if (!data || data.version !== 1 || !Array.isArray(data.groups)) return fail(t(EN, 'delete.bad_report', {file}));
  if (typeof data.createdAt !== 'number' || Date.now() - data.createdAt > DAY_MS) {
    process.stdout.write(t(EN, 'delete.old_report') + '\n');
  }

  const ctx = makeContext({busy: flags.busy ?? []});
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

const command = process.argv[2];

if (command === 'strings') {
  process.stdout.write(JSON.stringify(EN, null, 2) + '\n');
} else if (command === 'report') {
  await report(parseFlags(process.argv.slice(3)));
} else if (command === 'delete') {
  await del(process.argv.slice(3));
} else {
  process.stderr.write(USAGE + '\n');
  process.exit(2);
}
