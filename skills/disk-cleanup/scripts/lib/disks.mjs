import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Total and free bytes per mount that holds any of `paths`.
 * Windows: one entry per drive letter. Elsewhere: `/` plus one entry per other device.
 * @returns {Promise<{mount: string, total: number, free: number}[]>}
 */
export async function listDisks(ctx, paths) {
  const mounts = new Map();
  if (ctx.platform === 'win32') {
    for (const p of paths) {
      const root = path.win32.parse(path.win32.resolve(p)).root;
      mounts.set(root.toUpperCase(), root);
    }
  } else {
    const byDev = new Map();
    for (const p of ['/', ...paths]) {
      try {
        const dev = (await fs.stat(p)).dev;
        if (!byDev.has(dev)) byDev.set(dev, p);
      } catch {
        // Unreachable path: no disk entry for it.
      }
    }
    for (const p of byDev.values()) mounts.set(p, p);
  }

  const disks = [];
  for (const mount of mounts.values()) {
    try {
      const st = await fs.statfs(mount);
      disks.push({mount, total: Number(st.bsize) * Number(st.blocks), free: Number(st.bsize) * Number(st.bavail)});
    } catch {
      // Drive without media or no access: skip it.
    }
  }
  return disks;
}
