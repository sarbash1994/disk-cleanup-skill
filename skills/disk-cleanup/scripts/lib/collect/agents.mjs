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
 * Ask when a session may use `dir` (a ctx.busy dir equal to or inside it, a change within 24 hours,
 * or an unfinished scan), else safe. Used by the report and again before deletion.
 * @returns {Promise<{tag:'safe'|'ask', reasonKey:string, params:object}>}
 */
export async function checkAgentTemp(dir, ctx) {
  const {newest, complete} = await newestMtimeInfo(dir, {limit: ctx.mtimeLimit});
  const busy = ctx.busy.some((b) => isInside(b, dir)) || !complete || newest > ctx.now - DAY_MS;
  if (busy) return {tag: 'ask', reasonKey: 'reason.agent_busy', params: {}};
  return {tag: 'safe', reasonKey: 'reason.agent_old', params: {days: Math.max(0, Math.floor((ctx.now - newest) / DAY_MS))}};
}

/**
 * One row per child folder of each agent temp folder, tagged by checkAgentTemp.
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
      const check = await checkAgentTemp(full, ctx);
      rows.push(makeRow({
        group: 'agents',
        label: `${agent}: ${entry.name}`,
        path: full,
        tag: check.tag,
        reason: {key: check.reasonKey, params: check.params},
        action: {type: 'rm', path: full},
      }));
    }
  }
  return rows;
}
