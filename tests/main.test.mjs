import test from 'node:test';
import assert from 'node:assert/strict';
import {collectAll} from '../skills/disk-cleanup/scripts/lib/main.mjs';

test('a throwing collector yields no rows and one stderr line; the others still run', async () => {
  const lines = [];
  const rows = await collectAll([
    ['projects', async () => ['a', 'b']],
    ['git', async () => { throw new Error('boom'); }],
    ['caches', async () => ['c']],
  ], (line) => lines.push(line));
  assert.deepEqual(rows, ['a', 'b', 'c']);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /git/);
  assert.match(lines[0], /boom/);
});
