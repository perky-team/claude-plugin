import { describe, expect, it } from 'vitest';
import { parseId, formatId, STATUSES, validateItem } from '../lib/schema.mjs';

describe('parseId', () => {
  it('parses task ids', () => {
    expect(parseId('t-12')).toEqual({ prefix: 't', n: 12 });
  });
  it('parses sub-task ids', () => {
    expect(parseId('st-3')).toEqual({ prefix: 'st', n: 3 });
  });
  it('returns null for unknown prefix', () => {
    expect(parseId('x-1')).toBeNull();
  });
  it('returns null for malformed input', () => {
    expect(parseId('t-')).toBeNull();
    expect(parseId('t-abc')).toBeNull();
    expect(parseId('')).toBeNull();
  });
  it('accepts Jira-style keys as opaque pass-through (returns null for prefix)', () => {
    expect(parseId('PROJ-15')).toBeNull();
  });
});

describe('validateItem', () => {
  const valid = {
    id: 't-1',
    type: 'task',
    title: 'X',
    description: '',
    status: 'todo',
    blockedBy: [],
    subTasks: [],
  };

  it('accepts a well-formed task', () => {
    expect(validateItem(valid)).toEqual({ ok: true });
  });
  it('rejects unknown status', () => {
    expect(validateItem({ ...valid, status: 'wontfix' })).toEqual({
      ok: false,
      error: expect.stringContaining('status'),
    });
  });
  it('rejects mismatched id prefix vs type', () => {
    expect(validateItem({ ...valid, id: 'st-1', type: 'task' }).ok).toBe(false);
    expect(validateItem({ ...valid, id: 't-1', type: 'sub-task' }).ok).toBe(false);
  });
  it('rejects missing required field', () => {
    const { title, ...noTitle } = valid;
    expect(validateItem(noTitle).ok).toBe(false);
  });
  it('accepts opaque Jira-key as id when type is provided externally', () => {
    expect(validateItem({ ...valid, id: 'PROJ-15' }).ok).toBe(true);
  });
});
