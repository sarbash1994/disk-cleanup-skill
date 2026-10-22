import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const DEFAULT_TIMEOUT_MS = 20_000;
// Characters cmd.exe would act on even inside double quotes.
const UNSAFE_ARG = /[%^&|<>\r\n]/;
// Allow-list: cmd.exe also splits a command name at ; , = and similar, so only plain names pass.
const SAFE_CMD_NAME = /^[A-Za-z0-9_.-]+\.cmd$/i;
const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

/** Drive roots (like `D:\`) that exist on this machine; only Windows has them. Network and removable drives too. */
function existingDrives() {
  if (process.platform !== 'win32') return [];
  const drives = [];
  for (let c = 67; c <= 90; c++) {
    const drive = `${String.fromCharCode(c)}:\\`;
    if (fs.existsSync(drive)) drives.push(drive);
  }
  return drives;
}

const DRIVES_TIMEOUT_MS = 10_000;
const DRIVE_ID = /^[A-Z]:$/i;

/**
 * Fixed local drives (DriveType 3) on Windows, so network shares and USB sticks are not searched.
 * Falls back to every existing drive when PowerShell fails; [] elsewhere.
 * @returns {Promise<string[]>} roots like `C:\`
 */
export async function fixedDrives({platform = process.platform, run = runCommand, fallback = existingDrives} = {}) {
  if (platform !== 'win32') return [];
  const res = await run('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select -Expand DeviceID"], {timeoutMs: DRIVES_TIMEOUT_MS});
  const drives = res.code === 0
    ? res.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => DRIVE_ID.test(l)).map((l) => `${l.toUpperCase()}\\`)
    : [];
  return drives.length ? drives : fallback();
}

/**
 * Context for the real machine. The current folder always counts as busy: a session may run there.
 * `run` never throws: it resolves code null when the command is missing or timed out.
 * @param {{busy?: string[], drives?: string[]}} [opts]
 */
export function makeContext({busy = [], drives = existingDrives()} = {}) {
  return {
    home: os.homedir(),
    tmp: os.tmpdir(),
    platform: process.platform,
    drives,
    env: process.env,
    now: Date.now(),
    busy: [...busy, process.cwd()],
    run: runCommand,
  };
}

/** Runs a command without a shell (except a checked .cmd on Windows); `env` is merged over process.env. */
function runCommand(cmd, args, {cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env} = {}) {
  return new Promise((resolve) => {
    const options = {cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8'};
    if (env) options.env = {...process.env, ...env};
    let file = cmd;
    let fileArgs = args;
    // Node >= 18.20 refuses to spawn .cmd files directly on Windows (EINVAL), so they go through the
    // shell with every argument quoted here; the shell never sees an unquoted or metacharacter-bearing argument.
    // The command name stays unquoted: cmd.exe resolves %~dp0 wrongly for a quoted .cmd found through PATH
    // (npm.cmd then looks for node_modules in the current folder), so it must be a plain bare name.
    if (process.platform === 'win32' && /\.cmd$/i.test(cmd)) {
      if (!SAFE_CMD_NAME.test(cmd) || args.some((part) => UNSAFE_ARG.test(String(part)))) {
        return resolve({code: null, stdout: '', stderr: 'unsafe argument'});
      }
      file = [cmd, ...args.map(quote)].join(' ');
      fileArgs = [];
      options.shell = true;
    }
    execFile(
      file,
      fileArgs,
      options,
      (err, stdout, stderr) => {
        if (!err) return resolve({code: 0, stdout, stderr});
        // err.code is a number for a non-zero exit, a string (ENOENT...) otherwise; killed = timeout.
        const code = typeof err.code === 'number' && !err.killed ? err.code : null;
        resolve({code, stdout: stdout ?? '', stderr: stderr ?? ''});
      },
    );
  });
}
