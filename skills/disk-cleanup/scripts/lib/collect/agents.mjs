import fs from 'node:fs/promises';
import path from 'node:path';
import {makeRow} from '../row.mjs';
import {newestMtimeInfo} from '../walk.mjs';
import {isInside} from './git.mjs';

const DAY_MS = 86_400_000;

// Only folders confirmed to hold cache or temp data belong here, never history, memory, settings or plugins.
// Cursor and Codex are left out: their official documentation names no cache-only or temp-only folder
// (Codex documents ~/.codex as one state root; Cursor documents none), so nothing is confirmed.
export const AGENT_TEMP = [
  {agent: 'Claude Code', dir: (ctx) => path.join(ctx.tmp, 'claude')},
];

/**
 * One row per child folder of each agent temp folder: ask when a session may use it
 * (a ctx.busy dir equal to or inside it, a change within 24 hours, or an unfinished scan), else safe.
 * @returns {Promise<import('../row.mjs').Row[]>}
 */
export async function collect(ctx) {
  const rows = [];
  for (const {agent, dir} of AGENT_TEMP) {
    const root = dir(ctx);
    let entries;
    try {
      entries = await fs.readdir(root, {withFileTypes: true});
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(root, entry.name);
      const {newest, complete} = await newestMtimeInfo(full, {limit: ctx.mtimeLimit});
      const busy = ctx.busy.some((b) => isInside(b, full)) || !complete || newest > ctx.now - DAY_MS;
      const days = Math.max(0, Math.floor((ctx.now - newest) / DAY_MS));
      rows.push(makeRow({
        group: 'agents',
        label: `${agent}: ${entry.name}`,
        path: full,
        tag: busy ? 'ask' : 'safe',
        reason: busy ? {key: 'reason.agent_busy', params: {}} : {key: 'reason.agent_old', params: {days}},
        action: {type: 'rm', path: full},
      }));
    }
  }
  return rows;
}
