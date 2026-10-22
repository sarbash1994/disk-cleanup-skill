import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const DEFAULT_TIMEOUT_MS = 20_000;
// Characters cmd.exe would act on even inside double quotes.
const UNSAFE_ARG = /[%^&|<>\r\n]/;
const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

/** Drive roots (like `D:\`) that exist on this machine; only Windows has them. */
function existingDrives() {
  if (process.platform !== 'win32') return [];
  const drives = [];
  for (let c = 67; c <= 90; c++) {
    const drive = `${String.fromCharCode(c)}:\\`;
    if (fs.existsSync(drive)) drives.push(drive);
  }
  return drives;
}

/**
 * Context for the real machine.
 * `run` never throws: it resolves code null when the command is missing or timed out.
 * @param {{busy?: string[]}} [opts]
 */
export function makeContext({busy = []} = {}) {
  return {
    home: os.homedir(),
    tmp: os.tmpdir(),
    platform: process.platform,
    drives: existingDrives(),
    env: process.env,
    now: Date.now(),
    busy,
    run(cmd, args, {cwd, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
      return new Promise((resolve) => {
        const options = {cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8'};
        let file = cmd;
        let fileArgs = args;
        // Node >= 18.20 refuses to spawn .cmd files directly on Windows (EINVAL), so they go through the
        // shell with every argument quoted here; the shell never sees an unquoted or metacharacter-bearing argument.
        // The command name stays unquoted: cmd.exe resolves %~dp0 wrongly for a quoted .cmd found through PATH
        // (npm.cmd then looks for node_modules in the current folder), so it must be a plain bare name.
        if (process.platform === 'win32' && /\.cmd$/i.test(cmd)) {
          if (/[\s"]/.test(cmd) || [cmd, ...args].some((part) => UNSAFE_ARG.test(String(part)))) {
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
    },
  };
}
