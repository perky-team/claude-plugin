import { describe, expect, it } from 'vitest';
import { summarize } from '../lib/summary.mjs';

const items = [
  { id: 't-1', type: 'task',     title: 'A', description: 'a',  status: 'done',        blockedBy: [] },
  { id: 't-2', type: 'task',     title: 'B', description: '',   status: 'in_progress', blockedBy: [] },
  { id: 'st-1', type: 'sub-task', parentId: 't-2', title: 'B1', description: 'b1', status: 'done', blockedBy: [] },
  { id: 'st-2', type: 'sub-task', parentId: 't-2', title: 'B2', description: '',   status: 'todo', blockedBy: [] },
  { id: 'st-3', type: 'sub-task', parentId: 't-1', title: 'A1', description: '',   status: 'done', blockedBy: [] },
];

describe('summarize', () => {
  it('without parentId — returns done top-level tasks', () => {
    expect(summarize(items)).toEqual([{ id: 't-1', title: 'A', description: 'a' }]);
  });
  it('with parentId — returns done sub-tasks of that parent only', () => {
    expect(summarize(items, { parentId: 't-2' })).toEqual([{ id: 'st-1', title: 'B1', description: 'b1' }]);
  });
  it('omits empty description', () => {
    const out = summarize([
      { id: 't-1', type: 'task', title: 'X', description: '', status: 'done', blockedBy: [] },
    ]);
    expect(out).toEqual([{ id: 't-1', title: 'X' }]);
  });
  it('throws if parentId not found', () => {
    expect(() => summarize(items, { parentId: 't-99' })).toThrow(/t-99/);
  });
});
