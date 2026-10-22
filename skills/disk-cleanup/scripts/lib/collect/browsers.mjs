import fs from 'node:fs/promises';
import path from 'node:path';
import {makeRow, withReal} from '../row.mjs';

async function subdirs(dir) {
  try {
    return (await fs.readdir(dir, {withFileTypes: true})).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Numeric dot-part comparison: 10.1 > 9.2. */
function compareParts(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/**
 * Rows for versioned entries: per `group` the highest version is keep, the rest safe.
 * @param {{name:string, group:string, version:number[]}[]} entries
 */
function rowsFor(entries, dirOf, labelOf) {
  const byGroup = new Map();
  for (const e of entries) {
    if (!byGroup.has(e.group)) byGroup.set(e.group, []);
    byGroup.get(e.group).push(e);
  }
  const rows = [];
  for (const list of byGroup.values()) {
    list.sort((a, b) => compareParts(b.version, a.version));
    const newest = list[0];
    for (const e of list) {
      const dir = dirOf(e);
      const isNewest = e === newest;
      rows.push(makeRow({
        group: 'browsers',
        label: labelOf(e),
        path: dir,
        tag: isNewest ? 'keep' : 'safe',
        reason: isNewest
          ? {key: 'reason.browser_newest', params: {}}
          : {key: 'reason.browser_old', params: {newest: newest.name}},
        action: {type: 'rm', path: dir},
      }));
    }
  }
  return rows;
}

function playwrightDir(ctx) {
  if (ctx.env.PLAYWRIGHT_BROWSERS_PATH) return ctx.env.PLAYWRIGHT_BROWSERS_PATH;
  if (ctx.platform === 'win32') {
    return path.join(ctx.env.LOCALAPPDATA || path.join(ctx.home, 'AppData', 'Local'), 'ms-playwright');
  }
  if (ctx.platform === 'darwin') return path.join(ctx.home, 'Library', 'Caches', 'ms-playwright');
  return path.join(ctx.home, '.cache', 'ms-playwright');
}

async function playwrightRows(ctx) {
  const root = playwrightDir(ctx);
  const entries = [];
  for (const name of await subdirs(root)) {
    const m = /^(.+)-(\d+)$/.exec(name);
    if (m) entries.push({name, group: m[1], version: [Number(m[2])]});
  }
  return rowsFor(entries, (e) => path.join(root, e.name), (e) => `Playwright ${e.name}`);
}

async function puppeteerRows(ctx) {
  const root = ctx.env.PUPPETEER_CACHE_DIR || path.join(ctx.home, '.cache', 'puppeteer');
  const rows = [];
  for (const browser of await subdirs(root)) {
    const entries = [];
    for (const name of await subdirs(path.join(root, browser))) {
      const m = /^[a-z0-9_]+-(\d+(?:\.\d+)*)$/i.exec(name);
      if (m) entries.push({name, group: browser, version: m[1].split('.').map(Number)});
    }
    rows.push(...rowsFor(entries, (e) => path.join(root, browser, e.name), (e) => `Puppeteer ${browser} ${e.name}`));
  }
  return rows;
}

/**
 * Downloaded test browsers. Entries that do not match the expected naming are left out.
 * @returns {Promise<import('../row.mjs').Row[]>}
 */
export async function collect(ctx) {
  return withReal([...(await playwrightRows(ctx)), ...(await puppeteerRows(ctx))]);
}
