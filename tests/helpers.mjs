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

function gitIn(cwd) {
  return (...args) => execFileSync('git', args, {cwd, stdio: 'pipe', encoding: 'utf8'});
}

/**
 * A bare origin and a clone of it with one commit on `main`, pushed,
 * and `origin/HEAD` pointing at `origin/main`. Returns {repo, origin}.
 */
export async function gitRepoWithOrigin() {
  const root = await tmpdir();
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  await fs.mkdir(origin);
  await fs.mkdir(repo);
  gitIn(origin)('init', '-q', '--bare', '-b', 'main');
  const git = gitIn(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  await writeTree(repo, {'README.md': 'hello\n'});
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  git('remote', 'set-head', 'origin', 'main');
  return {repo, origin};
}

/**
 * Adds a worktree on a new branch (from main) under `<repo>/.claude/worktrees/<name>`,
 * name = branch with `/` replaced by `-`. Returns the worktree path.
 * opts: commit (one commit on the branch), push (push the branch),
 * mergeIntoMainAndPush, cherryPickIntoMainAndPush, untracked (file name to leave
 * untracked), lock, detach (detached HEAD at main instead of a branch).
 */
export async function addWorktree(repo, branch, opts = {}) {
  const name = branch.replace(/\//g, '-');
  const wt = path.join(repo, '.claude', 'worktrees', name);
  const git = gitIn(repo);
  if (opts.detach) git('worktree', 'add', '-q', '--detach', wt, 'main');
  else git('worktree', 'add', '-q', '-b', branch, wt, 'main');
  const wgit = gitIn(wt);
  if (opts.commit) {
    await writeTree(wt, {[`${name}.txt`]: `${branch}\n`});
    wgit('add', '-A');
    wgit('commit', '-q', '-m', `work on ${branch}`);
  }
  if (opts.push) wgit('push', '-q', 'origin', branch);
  if (opts.mergeIntoMainAndPush) {
    git('merge', '-q', '--no-ff', '-m', `merge ${branch}`, branch);
    git('push', '-q', 'origin', 'main');
  }
  if (opts.cherryPickIntoMainAndPush) {
    // main moves on first, so the picked commit gets a new hash and the branch is no ancestor.
    git('commit', '-q', '--allow-empty', '-m', 'main moves on');
    git('cherry-pick', branch);
    git('push', '-q', 'origin', 'main');
  }
  if (opts.untracked) await writeTree(wt, {[opts.untracked]: 'untracked\n'});
  if (opts.lock) git('worktree', 'lock', wt);
  return wt;
}
