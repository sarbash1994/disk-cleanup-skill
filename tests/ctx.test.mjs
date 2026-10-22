import test from 'node:test';
import assert from 'node:assert/strict';
import {fixedDrives, makeContext} from '../skills/disk-cleanup/scripts/lib/ctx.mjs';

const Z = ['Z:\\'];

test('makeContext always counts the current folder as busy', () => {
  const ctx = makeContext({busy: ['x']});
  assert.ok(ctx.busy.includes('x'));
  assert.ok(ctx.busy.includes(process.cwd()));
  assert.ok(makeContext().busy.includes(process.cwd()));
});

test('fixedDrives keeps only drive letters from the listing, falls back on failure', async () => {
  const listed = async () => ({code: 0, stdout: 'C:\r\nD:\r\nnonsense\r\n\r\n', stderr: ''});
  assert.deepEqual(await fixedDrives({platform: 'win32', run: listed, fallback: () => Z}), ['C:\\', 'D:\\']);
  const failed = async () => ({code: null, stdout: '', stderr: ''});
  assert.deepEqual(await fixedDrives({platform: 'win32', run: failed, fallback: () => Z}), Z);
  const empty = async () => ({code: 0, stdout: '\r\n', stderr: ''});
  assert.deepEqual(await fixedDrives({platform: 'win32', run: empty, fallback: () => Z}), Z);
  assert.deepEqual(await fixedDrives({platform: 'linux', run: listed}), []);
});

test('fixedDrives asks PowerShell for fixed disks only, with a 10 s timeout', async () => {
  const calls = [];
  const run = async (cmd, args, opts) => { calls.push([cmd, args, opts]); return {code: 0, stdout: 'C:\n', stderr: ''}; };
  await fixedDrives({platform: 'win32', run});
  assert.equal(calls[0][0], 'powershell');
  assert.ok(calls[0][1].includes('-NoProfile'));
  assert.match(calls[0][1].join(' '), /DriveType=3/);
  assert.equal(calls[0][2].timeoutMs, 10_000);
});

test('run merges an env over process.env', async () => {
  const ctx = makeContext();
  const res = await ctx.run(process.execPath, ['-e', 'process.stdout.write(process.env.DC_TEST_VAR + "|" + Boolean(process.env.PATH))'],
    {env: {DC_TEST_VAR: 'set'}});
  assert.equal(res.stdout, 'set|true');
});
