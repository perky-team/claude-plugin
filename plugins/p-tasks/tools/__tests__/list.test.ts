import { describe, expect, it } from 'vitest';
import { listAll } from '../lib/list.mjs';

const items = [
  { id: 't-1', type: 'task', title: 'A', description: 'a', status: 'in_progress', blockedBy: [] },
  { id: 'st-1', type: 'sub-task', parentId: 't-1', title: 'A1', description: '', status: 'done', blockedBy: [], acceptance: 'tests pass', files: ['a.ts'], kind: 'code', origin: 'plan' },
  { id: 'st-2', type: 'sub-task', parentId: 't-1', title: 'A2', description: '', status: 'todo', blockedBy: ['st-1'], kind: 'non-code', origin: 'code-review:blocker' },
  { id: 't-2', type: 'task', title: 'B', description: '', status: 'todo', blockedBy: [] },
];

describe('listAll', () => {
  it('returns ALL items in document order regardless of status', () => {
    const out = listAll(items);
    expect(out.map(i => i.id)).toEqual(['t-1', 'st-1', 'st-2', 't-2']);
    expect(out.map(i => i.status)).toEqual(['in_progress', 'done', 'todo', 'todo']);
  });
  it('carries the optional work-item fields through', () => {
    const out = listAll(items);
    expect(out.find(i => i.id === 'st-1')).toMatchObject({
      acceptance: 'tests pass', files: ['a.ts'], kind: 'code', origin: 'plan',
    });
    expect(out.find(i => i.id === 'st-2')).toMatchObject({
      kind: 'non-code', origin: 'code-review:blocker', blockedBy: ['st-1'],
    });
  });
  it('omits empty optional fields and empty blockedBy', () => {
    const out = listAll(items);
    const t2 = out.find(i => i.id === 't-2')!;
    expect(t2).toEqual({ id: 't-2', type: 'task', title: 'B', status: 'todo' });
  });
  it('with a parentId — returns that parent\'s sub-tasks in order (any status)', () => {
    const out = listAll(items, { parentId: 't-1' });
    expect(out.map(i => i.id)).toEqual(['st-1', 'st-2']);
  });
  it('throws when the parentId is unknown', () => {
    expect(() => listAll(items, { parentId: 't-99' })).toThrow(/t-99/);
  });
});
