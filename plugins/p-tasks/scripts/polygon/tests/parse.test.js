import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIni } from '../src/parse.js';

test('reads a section and a key', () => {
  assert.deepEqual(parseIni('[a]\nx = 1\n'), { a: { x: '1' } });
});

test('throws on a line it cannot read', () => {
  assert.throws(() => parseIni('[a]\n???\n'), { message: 'line 2: ???' });
});
