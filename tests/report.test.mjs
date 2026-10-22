import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {makeRow} from '../skills/disk-cleanup/scripts/lib/row.mjs';
import {EN} from '../skills/disk-cleanup/scripts/lib/strings.mjs';
import {buildReport, renderHtml, renderSummary, formatBytes} from '../skills/disk-cleanup/scripts/lib/report.mjs';
import {SCAN, tmpdir, writeTree} from './helpers.mjs';

const execFileP = promisify(execFile);

const row = (group, bytes, extra = {}) => makeRow({
  group, label: `${group} ${bytes}`, tag: 'safe', reason: {key: 'reason.cache_clean', params: {}}, bytes, ...extra,
});

test('groups sorted by size and ids follow display order', () => {
  const r = buildReport([row('caches', 900), row('projects', 100), row('projects', 300)], [], {now: 0});
  assert.deepEqual(r.groups.map(g => g.group), ['caches', 'projects']);
  assert.deepEqual(r.groups.flatMap(g => g.rows.map(x => [x.id, x.bytes])), [[1, 900], [2, 300], [3, 100]]);
  assert.equal(r.version, 1);
  assert.equal(r.groups[1].bytes, 400);
});

test('null sizes count as zero and sort last', () => {
  const r = buildReport([row('caches', null), row('caches', 5)], [], {now: 0});
  assert.deepEqual(r.groups[0].rows.map(x => x.bytes), [5, null]);
  assert.equal(r.groups[0].bytes, 5);
});

test('formatBytes uses 1024-based units with one decimal', () => {
  assert.equal(formatBytes(8.4 * 1024 ** 3), '8.4 GB');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(3 * 1024 ** 2), '3.0 MB');
});

test('renderHtml escapes paths and uses translated strings', () => {
  const r = buildReport([row('projects', 10, {path: 'C:\a <b> & "c"'})], [], {now: 0});
  const html = renderHtml(r, {...EN, 'group.projects': 'Проекты'});
  assert.ok(html.includes('C:\a &lt;b&gt; &amp; &quot;c&quot;'));
  assert.ok(html.includes('Проекты'));
  assert.ok(!/https?:\/\//.test(html));
  assert.ok(!html.includes('<b>'));
});

test('renderHtml shows ids, unknown size, show-row command and the hint', () => {
  const r = buildReport([
    row('heavy', null, {tag: 'show', path: '/x', command: "docker 'prune' <all>"}),
    row('caches', 2048),
  ], [{mount: '/data', total: 100 * 1024 ** 3, free: 40 * 1024 ** 3}], {now: 0});
  const html = renderHtml(r, EN);
  assert.ok(html.includes('#1'));
  assert.ok(html.includes('size unknown'));
  assert.ok(html.includes('docker &#39;prune&#39; &lt;all&gt;'));
  assert.ok(html.includes(EN.answer_hint));
  assert.ok(html.includes('40.0 GB free of 100.0 GB'));
  assert.ok(html.includes('prefers-color-scheme: dark'));
});

test('renderSummary lists group totals and the largest deletable rows only', () => {
  const rows = [
    row('caches', 900, {label: 'npm cache'}),
    row('heavy', 5000, {label: 'Docker', tag: 'show'}),
    row('projects', 300, {label: 'old modules', tag: 'ask'}),
    row('projects', 50, {label: 'kept', tag: 'keep'}),
  ];
  const s = renderSummary(buildReport(rows, [], {now: 0}), EN, {top: 5});
  assert.ok(s.includes('Heavy tools: 4.9 KB'));
  assert.ok(/#2\b.*npm cache.*900 B.*safe/.test(s));
  assert.ok(/#3\b.*old modules.*300 B.*ask/.test(s));
  assert.ok(!s.includes('Docker\n') && !/#\d+ .*Docker/.test(s));
  assert.ok(!/#\d+ .*kept/.test(s));
});

test('report command writes both files and prints their paths', async () => {
  const base = await tmpdir();
  const dirs = {};
  for (const name of ['home', 'temp', 'local', 'appdata', 'npm', 'pw', 'pptr', 'roots']) {
    dirs[name] = path.join(base, name);
    await writeTree(base, {[name]: null});
  }
  const env = {
    PATH: path.dirname(process.execPath),
    HOME: dirs.home, USERPROFILE: dirs.home,
    TEMP: dirs.temp, TMP: dirs.temp, TMPDIR: dirs.temp,
    LOCALAPPDATA: dirs.local, APPDATA: dirs.appdata,
    npm_config_cache: dirs.npm, PLAYWRIGHT_BROWSERS_PATH: dirs.pw, PUPPETEER_CACHE_DIR: dirs.pptr,
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const {stdout} = await execFileP(process.execPath, [SCAN, 'report', '--roots', dirs.roots], {env});
  assert.match(stdout, /report\.html/);
  assert.match(stdout, /report\.json/);
  const jsonPath = stdout.split(/\r?\n/).map(l => l.trim()).find(l => l.endsWith('report.json'));
  const json = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  assert.equal(json.version, 1);
  const html = await fs.readFile(jsonPath.replace(/json$/, 'html'), 'utf8');
  assert.ok(html.includes('<html'));
});
