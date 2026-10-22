import {GROUPS} from './row.mjs';
import {t} from './strings.mjs';

const DELETABLE = new Set(['safe', 'ask']);
const TAGS = ['safe', 'ask', 'keep', 'show'];

/** 1024-based size with one decimal, for example `8.4 GB`; under 1 KB plain bytes. */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(1)} ${units[i]}`;
}

const size = (strings, bytes) => (bytes === null ? t(strings, 'size_unknown') : formatBytes(bytes));

/**
 * Groups rows, sorts groups and rows by size (null counts as 0) and numbers the rows 1..n in display order.
 * @param {import('./row.mjs').Row[]} rows
 * @param {{mount:string,total:number,free:number}[]} disks
 * @param {{now:number}} opts
 */
export function buildReport(rows, disks, {now}) {
  const groups = GROUPS
    .map((group) => {
      const own = rows.filter((r) => r.group === group)
        .map((r) => ({...r}))
        .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
      return {group, bytes: own.reduce((sum, r) => sum + (r.bytes ?? 0), 0), rows: own};
    })
    .filter((g) => g.rows.length > 0)
    .sort((a, b) => b.bytes - a.bytes);
  let id = 1;
  for (const g of groups) for (const r of g.rows) r.id = id++;
  return {version: 1, createdAt: now, disks, groups};
}

const ESCAPES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const CSS = `
:root {
  --bg: #fbfaf7; --surface: #ffffff; --text: #1f2328; --muted: #565d65; --line: #d9d6cf;
  --accent: #1d6f5c; --track: #e8e5de;
  --safe-bg: #dcefe7; --safe-fg: #14503f;
  --ask-bg: #f6e6c4; --ask-fg: #6b4a00;
  --keep-bg: #e4e2dc; --keep-fg: #3f4448;
  --show-bg: #dde6f3; --show-fg: #2a4468;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15171a; --surface: #1d2024; --text: #e8e6e1; --muted: #a5abb2; --line: #34393f;
    --accent: #4fb89d; --track: #2b2f34;
    --safe-bg: #1c3b31; --safe-fg: #a6e2cd;
    --ask-bg: #473714; --ask-fg: #f0d28a;
    --keep-bg: #2d3136; --keep-fg: #c9ced3;
    --show-bg: #223349; --show-fg: #b5cdee;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.6rem; margin: 0 0 4px; }
h2 { font-size: 1.15rem; margin: 0; display: flex; justify-content: space-between; gap: 12px; }
.meta { color: var(--muted); margin: 0; }
.disks { list-style: none; padding: 0; margin: 8px 0 24px; color: var(--muted); }
.mono, .path, .cmd { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 0.85em; }
section { margin: 0 0 28px; }
.bar { height: 8px; background: var(--track); border-radius: 4px; margin: 6px 0 10px; }
.bar > span { display: block; height: 100%; background: var(--accent); border-radius: 4px; }
.row { background: var(--surface); border: 1px solid var(--line); padding: 8px 12px; margin: -1px 0 0;
  display: grid; grid-template-columns: 3.5em 1fr auto; gap: 2px 12px; }
.id { color: var(--muted); font-family: ui-monospace, Consolas, monospace; }
.label { font-weight: 600; }
.size { color: var(--muted); font-weight: 400; white-space: nowrap; }
.path, .cmd { color: var(--muted); grid-column: 2 / 4; overflow-wrap: anywhere; }
.reason { color: var(--muted); grid-column: 2 / 4; }
.tag { grid-column: 3 / 4; grid-row: 1; justify-self: end; padding: 0 8px; border-radius: 3px; font-size: 0.8em; }
.tag.safe { background: var(--safe-bg); color: var(--safe-fg); }
.tag.ask { background: var(--ask-bg); color: var(--ask-fg); }
.tag.keep { background: var(--keep-bg); color: var(--keep-fg); }
.tag.show { background: var(--show-bg); color: var(--show-fg); }
footer { border-top: 1px solid var(--line); padding-top: 12px; color: var(--muted); }
`;

function renderRow(row, strings) {
  const tag = TAGS.includes(row.tag) ? row.tag : 'keep';
  return `<div class="row">
<span class="id">#${esc(row.id)}</span>
<span class="label">${esc(row.label)} <span class="size">${esc(size(strings, row.bytes))}</span></span>
<span class="tag ${tag}">${esc(t(strings, `tag.${row.tag}`))}</span>
${row.path ? `<span class="path">${esc(row.path)}</span>` : ''}
<span class="reason">${esc(t(strings, row.reason.key, row.reason.params))}</span>
${row.command ? `<span class="cmd">${esc(row.command)}</span>` : ''}
</div>`;
}

/** Self-contained HTML page: no external assets, colours as CSS variables. */
export function renderHtml(report, strings) {
  const largest = Math.max(0, ...report.groups.map((g) => g.bytes));
  const time = new Date(report.createdAt).toISOString().slice(0, 16).replace('T', ' ');
  const disks = report.disks.map((d) => `<li><span class="mono">${esc(d.mount)}</span> ${esc(
    t(strings, 'disk_free', {free: formatBytes(d.free), total: formatBytes(d.total)}))}</li>`).join('\n');
  const groups = report.groups.map((g) => {
    const width = largest > 0 ? (g.bytes / largest) * 100 : 0;
    return `<section>
<h2><span>${esc(t(strings, `group.${g.group}`))}</span><span>${esc(formatBytes(g.bytes))}</span></h2>
<div class="bar"><span style="width:${width.toFixed(1)}%"></span></div>
${g.rows.map((r) => renderRow(r, strings)).join('\n')}
</section>`;
  }).join('\n');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t(strings, 'title'))}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${esc(t(strings, 'title'))}</h1>
<p class="meta">${esc(t(strings, 'scanned_at', {time}))}</p>
<ul class="disks">
${disks}
</ul>
${groups}
<footer>${esc(t(strings, 'answer_hint'))}</footer>
</main>
</body>
</html>
`;
}

/** Chat text: one line per group, then the `top` largest rows that can be deleted. */
export function renderSummary(report, strings, {top = 5} = {}) {
  const lines = report.groups.map((g) => `${t(strings, `group.${g.group}`)}: ${formatBytes(g.bytes)}`);
  const best = report.groups.flatMap((g) => g.rows)
    .filter((r) => DELETABLE.has(r.tag))
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
    .slice(0, top);
  if (best.length) lines.push('');
  for (const r of best) {
    lines.push(`#${r.id} ${r.label}  ${size(strings, r.bytes)}  ${t(strings, `tag.${r.tag}`)}`);
  }
  return lines.join('\n');
}
