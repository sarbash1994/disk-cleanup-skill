/** @typedef {'projects'|'caches'|'browsers'|'agents'|'heavy'} Group */
/** @typedef {'safe'|'ask'|'keep'|'show'} Tag */
/** @typedef {{type:'rm', path:string}
 *          | {type:'cmd', cmd:string, args:string[]}
 *          | {type:'worktree', repo:string, path:string, branch:string|null}
 *          | {type:'none'}} Action */
/** @typedef {{id:number, group:Group, label:string, path:string|null,
 *            bytes:number|null, tag:Tag, reason:{key:string, params:object},
 *            action:Action, command?:string, real?:string|null}} Row */

import fs from 'node:fs/promises';

/**
 * Stores `real`, the resolved path the report saw, on every rm and worktree row;
 * delete refuses a row whose path resolves elsewhere by then. null when the path cannot be resolved.
 * @param {Row[]} rows
 */
export async function withReal(rows) {
  for (const row of rows) {
    if ((row.action?.type === 'rm' || row.action?.type === 'worktree') && row.path) {
      row.real = await fs.realpath(row.path).catch(() => null);
    }
  }
  return rows;
}

/** Display order of the report groups. */
export const GROUPS = ['projects', 'caches', 'browsers', 'agents', 'heavy'];

/**
 * Builds a row. `id` stays 0 until buildReport numbers the rows.
 * @param {Partial<Row> & Pick<Row, 'group'|'label'|'tag'|'reason'>} fields
 * @returns {Row}
 */
export function makeRow(fields) {
  return {
    id: 0,
    path: null,
    bytes: null,
    action: {type: 'none'},
    ...fields,
  };
}
