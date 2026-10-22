/** @typedef {'projects'|'caches'|'browsers'|'agents'|'heavy'} Group */
/** @typedef {'safe'|'ask'|'keep'|'show'} Tag */
/** @typedef {{type:'rm', path:string}
 *          | {type:'cmd', cmd:string, args:string[]}
 *          | {type:'worktree', repo:string, path:string, branch:string|null}
 *          | {type:'none'}} Action */
/** @typedef {{id:number, group:Group, label:string, path:string|null,
 *            bytes:number|null, tag:Tag, reason:{key:string, params:object},
 *            action:Action, command?:string}} Row */

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
