import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/schema.js';

test('converts a number', () => {
  const r = validate({ a: { x: '2' } }, { 'a.x': { type: 'number' } });
  assert.deepEqual(r, { ok: true, value: { a: { x: 2 } } });
});

test('reports a missing required key', () => {
  const r = validate({}, { 'a.x': { type: 'string', required: true } });
  assert.deepEqual(r, { ok: false, errors: [{ path: 'a.x', message: 'is required' }] });
});
