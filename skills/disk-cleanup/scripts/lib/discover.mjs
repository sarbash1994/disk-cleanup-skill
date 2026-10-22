import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** Folder names never searched for projects, per platform. */
export const SKIP_DIRS = {
  win32: ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'AppData',
          '$Recycle.Bin', 'System Volume Information'],
  darwin: ['System', 'Library', 'Applications', 'Volumes', 'private'],
  linux: ['proc', 'sys', 'usr', 'var', 'dev', 'etc', 'boot', 'bin', 'sbin', 'lib', 'lib64', 'snap'],
};

/** Names compare case-insensitively on Windows and macOS. */
const folder = (ctx) => (s) => (ctx.platform === 'win32' || ctx.platform === 'darwin' ? s.toLowerCase() : s);

function isInside(child, parent, ctx) {
  const f = folder(ctx);
  const rel = path.relative(f(parent), f(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Folders under `roots` that contain `.git` (folder or file), outermost only.
 * @param {string[]} roots
 * @param {object} ctx
 * @param {{maxDepth?: number}} [opts]
 */
export async function findRepos(roots, ctx, {maxDepth = 8} = {}) {
  const f = folder(ctx);
  const skipNames = new Set([...(SKIP_DIRS[ctx.platform] ?? []), 'node_modules'].map(f));
  // Skipped only at exactly this place, not wherever the name occurs.
  const skipPaths = new Set();
  if (ctx.platform === 'darwin') skipPaths.add(f(path.join(ctx.home, 'Library')));
  if (ctx.platform === 'linux') skipPaths.add(f(path.join(ctx.home, '.cache')));

  const found = new Set();
  const seen = new Set();

  async function visit(dir, depth) {
    const key = f(dir);
    if (seen.has(key)) return;
    seen.add(key);
    let entries;
    try {
      entries = await fsp.readdir(dir, {withFileTypes: true});
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) {
      found.add(dir);
      return;
    }
    if (depth >= maxDepth) return;
    const subdirs = entries.filter((e) => e.isDirectory()
      && !e.name.startsWith('.')
      && !skipNames.has(f(e.name))
      && !skipPaths.has(f(path.join(dir, e.name))));
    await Promise.all(subdirs.map((e) => visit(path.join(dir, e.name), depth + 1)));
  }

  for (const root of roots) await visit(root, 0);
  return [...found];
}

/** IDE settings folders: VS Code, Cursor and every JetBrains product folder. */
async function ideFolders(ctx) {
  let base;
  if (ctx.platform === 'win32') base = ctx.env.APPDATA || path.join(ctx.home, 'AppData', 'Roaming');
  else if (ctx.platform === 'darwin') base = path.join(ctx.home, 'Library', 'Application Support');
  else base = path.join(ctx.home, '.config');

  const folders = {vscode: [path.join(base, 'Code'), path.join(base, 'Cursor')], jetbrains: []};
  try {
    const products = await fsp.readdir(path.join(base, 'JetBrains'), {withFileTypes: true});
    for (const p of products) if (p.isDirectory()) folders.jetbrains.push(path.join(base, 'JetBrains', p.name));
  } catch {
    // No JetBrains IDE installed.
  }
  return folders;
}

function uriToPath(value) {
  if (typeof value !== 'string' || !value.startsWith('file:')) return null;
  try {
    return fileURLToPath(value);
  } catch {
    return null;
  }
}

async function vscodeProjects(settingsDir) {
  try {
    const json = JSON.parse(await fsp.readFile(path.join(settingsDir, 'User', 'globalStorage', 'storage.json'), 'utf8'));
    const uris = [
      ...(json.openedPathsList?.entries ?? []).map((e) => e?.folderUri),
      ...(json.backupWorkspaces?.folders ?? []).map((e) => e?.folderUri),
    ];
    return uris.map(uriToPath).filter(Boolean);
  } catch {
    return [];
  }
}

async function jetbrainsProjects(productDir, ctx) {
  try {
    const xml = await fsp.readFile(path.join(productDir, 'options', 'recentProjects.xml'), 'utf8');
    return [...xml.matchAll(/<entry key="([^"]+)"/g)]
      .map((m) => m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replaceAll('$USER_HOME$', ctx.home))
      .map((p) => path.normalize(p));
  } catch {
    return [];
  }
}

/**
 * Where to look for projects: home, every other Windows drive, and existing
 * folders from IDE recent-project lists that are not inside another root.
 */
export async function defaultRoots(ctx) {
  const roots = [ctx.home];
  if (ctx.platform === 'win32') {
    const homeDrive = path.win32.parse(ctx.home).root.toUpperCase();
    for (let c = 67; c <= 90; c++) {
      const drive = `${String.fromCharCode(c)}:\\`;
      if (drive !== homeDrive && fs.existsSync(drive)) roots.push(drive);
    }
  }

  const ide = await ideFolders(ctx);
  const candidates = [
    ...(await Promise.all(ide.vscode.map(vscodeProjects))).flat(),
    ...(await Promise.all(ide.jetbrains.map((d) => jetbrainsProjects(d, ctx)))).flat(),
  ];

  const existing = [];
  for (const p of new Set(candidates)) {
    try {
      if ((await fsp.stat(p)).isDirectory()) existing.push(p);
    } catch {
      // Project folder no longer exists.
    }
  }
  existing.sort((a, b) => a.length - b.length);
  for (const p of existing) {
    if (!roots.some((r) => isInside(p, r, ctx))) roots.push(p);
  }
  return roots;
}
