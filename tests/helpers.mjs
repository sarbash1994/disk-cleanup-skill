import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const SCAN = fileURLToPath(new URL('../skills/disk-cleanup/scripts/scan.mjs', import.meta.url));

/** Creates a fresh temporary folder and returns its real path. */
export async function tmpdir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'disk-cleanup-test-')));
}

/**
 * Builds a file tree under root. Keys are relative paths with `/`;
 * a string value is file content, `null` makes an empty folder.
 */
export async function writeTree(root, tree) {
  for (const [rel, content] of Object.entries(tree)) {
    const full = path.join(root, ...rel.split('/'));
    if (content === null) {
      await fs.mkdir(full, {recursive: true});
    } else {
      await fs.mkdir(path.dirname(full), {recursive: true});
      await fs.writeFile(full, content);
    }
  }
}

/**
 * Synchronous fake ctx. home and tmp default to unique, not-yet-created
 * subpaths of os.tmpdir(); tests that need real folders pass their own.
 * `run` resolves {code: null, stdout: '', stderr: ''} unless overridden.
 */
let counter = 0;
export function fakeCtx(overrides = {}) {
  const base = path.join(os.tmpdir(), `disk-cleanup-fake-${process.pid}-${Date.now()}-${counter++}`);
  return {
    home: path.join(base, 'home'),
    tmp: path.join(base, 'tmp'),
    platform: process.platform,
    env: {},
    now: Date.now(),
    busy: [],
    run: async () => ({code: null, stdout: '', stderr: ''}),
    ...overrides,
  };
}
