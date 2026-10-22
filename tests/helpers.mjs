import {execFileSync} from 'node:child_process';
import {makeContext} from '../skills/disk-cleanup/scripts/lib/ctx.mjs';
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
    drives: [],
    env: {},
    now: Date.now(),
    busy: [],
    run: async () => ({code: null, stdout: '', stderr: ''}),
    ...overrides,
  };
}

/** Real command runner (same one the CLI uses), for tests that need git. */
export const realRun = makeContext({}).run;

/**
 * Creates a git repo in a fresh temporary folder with one commit made at commitDate.
 * `files` is a writeTree tree. Returns the repo path.
 */
export async function gitRepo({files, commitDate}) {
  const repo = await tmpdir();
  const env = {...process.env, GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate};
  const git = (...args) => execFileSync('git', args, {cwd: repo, env, stdio: 'pipe'});
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  await writeTree(repo, files);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return repo;
}

/** Sets atime and mtime of dir and everything under it (symlinks are not followed). */
export async function setAllMtimes(dir, date) {
  const entries = await fs.readdir(dir, {withFileTypes: true});
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await setAllMtimes(full, date);
    else await fs.utimes(full, date, date);
  }
  await fs.utimes(dir, date, date);
}
