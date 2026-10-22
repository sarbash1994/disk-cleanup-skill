import fs from 'node:fs/promises';
import path from 'node:path';
import {makeRow} from '../row.mjs';

const UNITS = {b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12};

async function isDir(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Sum of docker's decimal sizes ("1.5GB"), or null when any line is not one. */
function sumSizes(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  let total = 0;
  for (const line of lines) {
    const m = /^([\d.]+)\s*([kmgt]?b)$/i.exec(line);
    if (!m) return null;
    total += parseFloat(m[1]) * UNITS[m[2].toLowerCase()];
  }
  return Math.round(total);
}

function androidSdkDir(ctx) {
  const fromEnv = ctx.env.ANDROID_HOME || ctx.env.ANDROID_SDK_ROOT;
  if (fromEnv) return fromEnv;
  if (ctx.platform === 'win32') return path.join(ctx.env.LOCALAPPDATA || path.join(ctx.home, 'AppData', 'Local'), 'Android', 'Sdk');
  if (ctx.platform === 'darwin') return path.join(ctx.home, 'Library', 'Android', 'sdk');
  return path.join(ctx.home, 'Android', 'Sdk');
}

/**
 * Show-only rows for heavy tools; nothing here is deleted by the script. Only existing folders are listed.
 * @returns {Promise<import('../row.mjs').Row[]>}
 */
export async function collect(ctx) {
  const rows = [];
  const show = (fields) => makeRow({
    group: 'heavy', tag: 'show', reason: {key: 'reason.heavy_show', params: {}}, action: {type: 'none'}, ...fields,
  });

  const df = await ctx.run('docker', ['system', 'df']);
  if (df.code === 0) {
    const sizes = await ctx.run('docker', ['system', 'df', '--format', '{{.Size}}']);
    rows.push(show({
      label: 'Docker',
      bytes: sizes.code === 0 ? sumSizes(sizes.stdout) : null,
      command: 'docker system prune',
    }));
  }

  const folders = [];
  if (ctx.platform === 'darwin') {
    folders.push(
      {label: 'Xcode DerivedData', dir: path.join(ctx.home, 'Library', 'Developer', 'Xcode', 'DerivedData'),
        command: 'rm -rf ~/Library/Developer/Xcode/DerivedData'},
      {label: 'iOS simulators', dir: path.join(ctx.home, 'Library', 'Developer', 'CoreSimulator'),
        command: 'xcrun simctl delete unavailable'},
    );
  }
  folders.push(
    {label: 'Android virtual devices', dir: path.join(ctx.home, '.android', 'avd'),
      command: 'delete in Android Studio Device Manager'},
    {label: 'Android SDK', dir: androidSdkDir(ctx), command: 'remove packages in Android Studio SDK Manager'},
    {label: 'Gradle cache', dir: path.join(ctx.home, '.gradle', 'caches'), command: 'gradle --stop, then delete ~/.gradle/caches'},
  );
  for (const f of folders) {
    if (await isDir(f.dir)) rows.push(show({label: f.label, path: f.dir, command: f.command}));
  }
  return rows;
}
