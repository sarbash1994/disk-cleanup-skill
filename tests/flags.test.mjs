import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFlags} from '../skills/disk-cleanup/scripts/lib/flags.mjs';

test('a repeated flag keeps every value', () => {
  assert.deepEqual(parseFlags(['--busy', 'A', '--busy', 'B']).busy, ['A', 'B']);
  assert.deepEqual(parseFlags(['--roots', 'C', '--busy', 'A', '--roots', 'D']), {roots: ['C', 'D'], busy: ['A']});
});

test('one flag takes several values', () => {
  assert.deepEqual(parseFlags(['--busy', 'A', 'B', '--strings', 's.json']), {busy: ['A', 'B'], strings: ['s.json']});
});

test('values before the first flag are ignored', () => {
  assert.deepEqual(parseFlags(['1-3', '5', '--busy', 'A']), {busy: ['A']});
});
