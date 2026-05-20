import { describe, expect, it } from 'vitest';
import { findCycle } from '../lib/cycles.mjs';

const items = [
  { id: 't-1', blockedBy: [] },
  { id: 't-2', blockedBy: ['t-1'] },
  { id: 't-3', blockedBy: ['t-2'] },
];

describe('findCycle', () => {
  it('returns null on an acyclic graph', () => {
    expect(findCycle(items)).toBeNull();
  });
  it('detects a direct self-loop', () => {
    expect(findCycle([{ id: 't-1', blockedBy: ['t-1'] }])).not.toBeNull();
  });
  it('detects a back-edge', () => {
    const merged = [{ id: 't-1', blockedBy: ['t-3'] }, items[1], items[2]];
    const cycle = findCycle(merged);
    expect(cycle).toEqual(expect.arrayContaining(['t-1', 't-2', 't-3']));
  });
  it('ignores blockedBy targets that are not in the graph', () => {
    expect(findCycle([{ id: 't-1', blockedBy: ['nope'] }])).toBeNull();
  });
});
