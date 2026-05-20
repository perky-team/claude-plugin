import { describe, expect, it } from 'vitest';
import { pickNext } from '../lib/next.mjs';

const items = [
  { id: 't-1', type: 'task',     title: 'A', description: '', status: 'in_progress', blockedBy: [] },
  { id: 't-2', type: 'task',     title: 'B', description: '', status: 'todo',        blockedBy: [] },
  { id: 't-3', type: 'task',     title: 'C', description: '', status: 'todo',        blockedBy: ['t-1'] },
  { id: 'st-1', type: 'sub-task', parentId: 't-1', title: 'A1', description: '', status: 'todo', blockedBy: [] },
  { id: 'st-2', type: 'sub-task', parentId: 't-2', title: 'B1', description: '', status: 'todo', blockedBy: [] },
];

describe('pickNext', () => {
  it('returns null when no candidates', () => {
    expect(pickNext([{ id: 't-1', type: 'task', status: 'done', blockedBy: [], title:'',description:'' }])).toBeNull();
  });
  it('prefers in_progress over todo', () => {
    const out = pickNext(items);
    expect(out.id).toBe('t-1');
  });
  it('prefers sub-task of in_progress parent over standalone todo', () => {
    const withoutT1 = items.filter(i => i.id !== 't-1').concat([
      { id: 't-1', type: 'task', title: 'A', description: '', status: 'in_progress', blockedBy: [] },
    ]);
    const out = pickNext(withoutT1, { all: true });
    const stOnly = out.filter((i: any) => i.id.startsWith('st-')).map((i: any) => i.id);
    expect(stOnly[0]).toBe('st-1');
  });
  it('excludes items whose blockers are not yet done', () => {
    expect(pickNext(items, { all: true }).map((i: any) => i.id)).not.toContain('t-3');
  });
  it('includes items whose blockers are all done', () => {
    const xs = [
      { id: 't-1', type: 'task', title: '', description: '', status: 'done', blockedBy: [] },
      { id: 't-2', type: 'task', title: '', description: '', status: 'todo', blockedBy: ['t-1'] },
    ];
    expect(pickNext(xs).id).toBe('t-2');
  });
  it('emits warning for non-existent blocker id and excludes the candidate', () => {
    const warns: string[] = [];
    const out = pickNext(
      [{ id: 't-1', type: 'task', title: '', description: '', status: 'todo', blockedBy: ['nope'] }],
      { all: true, onWarn: (m: string) => warns.push(m) },
    );
    expect(out).toEqual([]);
    expect(warns[0]).toMatch(/nope/);
  });
});
