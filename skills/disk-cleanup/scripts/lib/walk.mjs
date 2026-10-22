import fs from 'node:fs/promises';
import path from 'node:path';

const CONCURRENCY = 64;

/** Reads a folder in chunks of up to CONCURRENCY entries. Unreadable folder: no entries. */
async function* entryChunks(dir) {
  let handle;
  try {
    handle = await fs.opendir(dir);
  } catch {
    return;
  }
  try {
    let chunk = [];
    for await (const entry of handle) {
      chunk.push(entry);
      if (chunk.length >= CONCURRENCY) {
        yield chunk;
        chunk = [];
      }
    }
    if (chunk.length) yield chunk;
  } catch {
    // The folder became unreadable mid-walk: keep what we have.
  }
}

/**
 * Total bytes of regular files under dir. Symlinks and junctions are not followed;
 * a file with several hard links is counted once. Unreadable entries are skipped.
 * Returns null when the deadline (ms since epoch) passes.
 */
export async function measureSize(dir, {deadline}) {
  if (Date.now() > deadline) return null;
  const seen = new Set();
  const stack = [dir];
  let total = 0;
  let expired = false;

  while (stack.length && !expired) {
    const current = stack.pop();
    for await (const chunk of entryChunks(current)) {
      if (Date.now() > deadline) { expired = true; break; }
      await Promise.all(chunk.map(async (entry) => {
        const full = path.join(current, entry.name);
        let st;
        try {
          st = await fs.lstat(full, {bigint: true});
        } catch {
          return;
        }
        if (st.isSymbolicLink()) return;
        if (st.isDirectory()) { stack.push(full); return; }
        if (!st.isFile()) return;
        if (st.nlink > 1n) {
          const key = `${st.dev}:${st.ino}`;
          if (seen.has(key)) return;
          seen.add(key);
        }
        total += Number(st.size);
      }));
    }
  }
  return expired ? null : total;
}

/**
 * Newest modification time (ms) of files under dir, not descending into folders
 * named in `skip`, looking at no more than `limit` entries. newest is 0 when nothing is found.
 * complete is false when the root cannot be read or the limit was reached
 * (reaching it counts as incomplete even if nothing was left).
 * @returns {Promise<{newest: number, complete: boolean}>}
 */
export async function newestMtimeInfo(dir, {skip = ['node_modules', '.git'], limit = 20000} = {}) {
  try {
    await (await fs.opendir(dir)).close();
  } catch {
    return {newest: 0, complete: false};
  }
  const skipped = new Set(skip);
  const stack = [dir];
  let newest = 0;
  let looked = 0;

  while (stack.length && looked < limit) {
    const current = stack.pop();
    for await (const chunk of entryChunks(current)) {
      const room = limit - looked;
      const batch = chunk.length > room ? chunk.slice(0, room) : chunk;
      looked += batch.length;
      await Promise.all(batch.map(async (entry) => {
        if (skipped.has(entry.name)) return;
        const full = path.join(current, entry.name);
        let st;
        try {
          st = await fs.lstat(full);
        } catch {
          return;
        }
        if (st.isSymbolicLink()) return;
        if (st.isDirectory()) stack.push(full);
        else if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
      }));
      if (looked >= limit) break;
    }
  }
  return {newest, complete: looked < limit};
}

/** newestMtimeInfo without the completeness flag. */
export async function newestMtime(dir, opts) {
  return (await newestMtimeInfo(dir, opts)).newest;
}
