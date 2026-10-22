import {execFile} from 'node:child_process';
import os from 'node:os';

const DEFAULT_TIMEOUT_MS = 20_000;

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
    env: process.env,
    now: Date.now(),
    busy,
    run(cmd, args, {cwd, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
      return new Promise((resolve) => {
        execFile(
          cmd,
          args,
          {cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8'},
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
