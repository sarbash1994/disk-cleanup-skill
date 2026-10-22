import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Thrown when the report folder or a file in it is a link or belongs to another user. */
export class UnsafePathError extends Error {
  constructor(p) {
    super(`unsafe path: ${p}`);
    this.path = p;
  }
}

/** Per-user report folder in the temp dir: on a shared /tmp another user cannot own or plant it. */
export function reportDir() {
  return path.join(os.tmpdir(), `disk-cleanup-${process.getuid?.() ?? os.userInfo().username}`);
}

/** True when `st` belongs to another user; always false where uids do not exist (Windows). */
export const foreign = (st) => typeof process.getuid === 'function' && st.uid !== process.getuid();

/** The folder must be a real directory of the current user; creates it with mode 0700 when missing. */
export async function prepareDir(dir) {
  try {
    await fs.mkdir(dir, {mode: 0o700});
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  await checkDir(dir);
  // Ours, so tighten it: nobody else may add, rename or remove files in it.
  if (typeof process.getuid === 'function') await fs.chmod(dir, 0o700);
}

/** Throws UnsafePathError unless `dir` is a real directory of the current user; ENOENT passes through. */
export async function checkDir(dir) {
  const st = await fs.lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || foreign(st)) throw new UnsafePathError(dir);
}

/** Writes a new file; an existing regular file of ours is replaced, anything else is refused. */
export async function writeOwnFile(file, text) {
  let st = null;
  try {
    st = await fs.lstat(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (st) {
    if (!st.isFile() || foreign(st)) throw new UnsafePathError(file);
    await fs.unlink(file);
  }
  // `wx` fails if anything, a link included, appeared at the path meanwhile.
  await fs.writeFile(file, text, {flag: 'wx', mode: 0o600});
}

/** Reads a file of ours in a folder of ours; a link or another user's file is refused, ENOENT passes through. */
export async function readOwnFile(file) {
  await checkDir(path.dirname(file));
  const st = await fs.lstat(file);
  if (!st.isFile() || foreign(st)) throw new UnsafePathError(file);
  return fs.readFile(file, 'utf8');
}
