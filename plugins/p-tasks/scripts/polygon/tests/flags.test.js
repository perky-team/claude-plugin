import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFlags } from '../src/flags.js';

test('reads --section.key=value', () => {
  assert.deepEqual(parseFlags(['--a.x=1']), { set: { a: { x: '1' } }, rest: [] });
});
