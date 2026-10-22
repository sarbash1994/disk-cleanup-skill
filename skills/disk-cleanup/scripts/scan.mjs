#!/usr/bin/env node
// No static imports: they would load and start the fs thread pool before the size below takes effect.
// Node's default pool of 4 threads caps every directory walk, so the CLI runs in a child with 16.
if (process.env.UV_THREADPOOL_SIZE) {
  const {main} = await import('./lib/main.mjs');
  await main(process.argv.slice(2));
} else {
  const {spawn} = await import('node:child_process');
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: {...process.env, UV_THREADPOOL_SIZE: '16'},
  });
  child.on('error', (err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
