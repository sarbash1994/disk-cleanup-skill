#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EN, loadStrings} from './lib/strings.mjs';
import {makeContext} from './lib/ctx.mjs';
import {measureSize} from './lib/walk.mjs';
import {listDisks} from './lib/disks.mjs';
import {defaultRoots, findRepos} from './lib/discover.mjs';
import {buildReport, renderHtml, renderSummary} from './lib/report.mjs';
import * as projects from './lib/collect/projects.mjs';
import * as git from './lib/collect/git.mjs';
import * as caches from './lib/collect/caches.mjs';
import * as browsers from './lib/collect/browsers.mjs';
import * as agents from './lib/collect/agents.mjs';
import * as heavy from './lib/collect/heavy.mjs';

const USAGE = 'Usage: node scan.mjs <strings|report|delete>';
const MEASURE_PARALLEL = 4;
const MEASURE_TIMEOUT_MS = 20_000;

/** `--flag a b c` collects values up to the next `--flag`. */
function parseFlags(args) {
  const flags = {};
  let current = null;
  for (const arg of args) {
    if (arg.startsWith('--')) {
      current = arg.slice(2);
      flags[current] = [];
    } else if (current) {
      flags[current].push(arg);
    }
  }
  return flags;
}

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

const command = process.argv[2];

if (command === 'strings') {
  process.stdout.write(JSON.stringify(EN, null, 2) + '\n');
} else if (command === 'report') {
  await report(parseFlags(process.argv.slice(3)));
} else {
  process.stderr.write(USAGE + '\n');
  process.exit(2);
}
