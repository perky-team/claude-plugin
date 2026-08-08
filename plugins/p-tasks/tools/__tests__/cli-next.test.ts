import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextCommand, initFs, addCommand, setCommand } from '../ptasks.mjs';
import { EXPLAIN_RANKING_CAP } from '../lib/next.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
let stderrSpy: any;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-next-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try { await initFs({ root: dir }); } catch {}
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  exitSpy.mockRestore(); stdoutSpy.mockRestore(); stderrSpy.mockRestore();
});

// Returns the raw bytes written to stdout, so the byte-for-byte tests below can assert key
// ORDER too — deep-equality on the parsed object would not notice a reordering.
async function runRaw(args: any): Promise<string> {
  stdoutSpy.mockClear();
  try { await nextCommand({ root: dir, args: { _: [], json: true, ...args } }); } catch {}
  return stdoutSpy.mock.calls[0][0] as string;
}
async function run(args: any): Promise<any> {
  return JSON.parse(await runRaw(args));
}

// t-1 in_progress carrying sub-task st-1; t-2 todo; t-3 blocked by the still-open t-2.
// Ranks [t-1, st-1, t-2]: in_progress wins, then the sub-task of the in-progress parent,
// then the remaining top-level todo. t-3 never ranks at all.
async function fixture() {
  try { await addCommand({ root: dir, args: { _: ['task'], title: 'A', json: true } }); } catch {}
  try { await addCommand({ root: dir, args: { _: ['task'], title: 'B', json: true } }); } catch {}
  try { await addCommand({ root: dir, args: { _: ['task'], title: 'C', 'blocked-by': 't-2', json: true } }); } catch {}
  try { await addCommand({ root: dir, args: { _: ['sub-task', 't-1'], title: 'A1', json: true } }); } catch {}
  try { await setCommand({ root: dir, args: { _: ['t-1'], status: 'in_progress', json: true } }); } catch {}
}

describe('nextCommand', () => {
  it('returns null when nothing actionable', async () => {
    expect(await run({})).toEqual({ next: null });
  });
  it('returns top-1 by default and the full list with --all', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'A', json: true } }); } catch {}
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'B', json: true } }); } catch {}
    try { await setCommand({ root: dir, args: { _: ['t-1'], status: 'in_progress', json: true } }); } catch {}
    expect((await run({})).next.id).toBe('t-1');
    expect((await run({ all: true })).items.map((i: any) => i.id)).toEqual(['t-1', 't-2']);
  });
});

describe('nextCommand --explain', () => {
  // p-shed guards and prompt-driven callers parse this envelope. Asserting the exact bytes
  // (not a subset, not a parsed shape) is what stops a later refactor from quietly adding a
  // field or reordering keys for callers that never asked for an explanation.
  it('emits byte-for-byte unchanged output without the flag', async () => {
    await fixture();
    expect(await runRaw({})).toBe(
      '{"next":{"id":"t-1","title":"A","description":"","status":"in_progress","blockedBy":[],"subTasks":[{"id":"st-1","title":"A1","description":"","status":"todo","blockedBy":[]}],"type":"task"}}\n',
    );
    expect(await runRaw({ all: true })).toBe(
      '{"items":[{"id":"t-1","title":"A","description":"","status":"in_progress","blockedBy":[],"subTasks":[{"id":"st-1","title":"A1","description":"","status":"todo","blockedBy":[]}],"type":"task"},{"id":"st-1","title":"A1","description":"","status":"todo","blockedBy":[],"type":"sub-task","parentId":"t-1"},{"id":"t-2","title":"B","description":"","status":"todo","blockedBy":[],"subTasks":[],"type":"task"}]}\n',
    );
  });

  it('ranks the picked item first', async () => {
    await fixture();
    const out = await run({ explain: true });
    expect(out.explain.ranking[0].id).toBe(out.next.id);
    expect(out.explain.ranking.map((r: any) => r.id)).toEqual(['t-1', 'st-1', 't-2']);
  });

  it('reports the key that explains the order', async () => {
    await fixture();
    const { explain } = await run({ explain: true });
    // st-1 outranks t-2 on parentInProgressRank alone: both are todo, and t- normally beats
    // st-, but st-1's parent is in progress. Lower wins on every one of the four keys.
    expect(explain.ranking[1]).toEqual({
      id: 'st-1',
      key: { statusRank: 1, parentInProgressRank: 0, prefixRank: 1, num: 1 },
    });
    expect(explain.ranking[2].key).toEqual({ statusRank: 1, parentInProgressRank: 1, prefixRank: 0, num: 2 });
    expect(explain.comparator).toMatch(/in_progress first/);
  });

  it('lists a blocked item under excluded with the blocker status, and never in ranking', async () => {
    await fixture();
    const { explain } = await run({ explain: true });
    expect(explain.excluded).toEqual([
      { id: 't-3', unsatisfiedBlockers: [{ id: 't-2', status: 'todo' }] },
    ]);
    expect(explain.ranking.map((r: any) => r.id)).not.toContain('t-3');
  });

  it('does not change the selection or the ordering', async () => {
    await fixture();
    expect((await run({ explain: true })).next).toEqual((await run({})).next);
    expect((await run({ all: true, explain: true })).items).toEqual((await run({ all: true })).items);
  });

  it('reports the blocker actual status, not merely that it is unsatisfied', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'A', json: true } }); } catch {}
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'B', 'blocked-by': 't-1', json: true } }); } catch {}
    try { await setCommand({ root: dir, args: { _: ['t-1'], status: 'in_progress', json: true } }); } catch {}
    // The motivating case: knowing the blocker is in_progress rather than todo is what tells
    // a caller whether the wait is already being worked on or has not started at all.
    const { explain } = await run({ explain: true });
    expect(explain.excluded).toEqual([
      { id: 't-2', unsatisfiedBlockers: [{ id: 't-1', status: 'in_progress' }] },
    ]);
  });

  it("lists every unsatisfied blocker, in the item's own blockedBy order", async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'A', json: true } }); } catch {}
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'B', json: true } }); } catch {}
    // Declared t-2 before t-1 on purpose: the output must follow the item's own array, not
    // the ranking order and not the order the blockers happen to sort in.
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'C', 'blocked-by': ['t-2', 't-1'], json: true } }); } catch {}
    const { explain } = await run({ explain: true });
    expect(explain.excluded).toEqual([
      { id: 't-3', unsatisfiedBlockers: [{ id: 't-2', status: 'todo' }, { id: 't-1', status: 'todo' }] },
    ]);
  });

  it('omits blockers that are already done', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'A', json: true } }); } catch {}
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'B', json: true } }); } catch {}
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'C', 'blocked-by': ['t-1', 't-2'], json: true } }); } catch {}
    try { await setCommand({ root: dir, args: { _: ['t-1'], status: 'done', json: true } }); } catch {}
    const { explain } = await run({ explain: true });
    expect(explain.excluded).toEqual([
      { id: 't-3', unsatisfiedBlockers: [{ id: 't-2', status: 'todo' }] },
    ]);
  });

  it('marks a blocker id that no longer exists, and still warns on stderr', async () => {
    // `add`/`set` both reject an unknown blocker, so this state only arises when the blocker
    // is deleted afterwards — written straight to tasks.yml because that is the only way to
    // reach it. Exactly the case where a caller most needs to be told why nothing is ready.
    writeFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'),
      "tasks:\n  - id: t-1\n    title: A\n    description: ''\n    status: todo\n    blockedBy:\n      - t-9\n    subTasks: []\n", 'utf-8');
    stderrSpy.mockClear();
    const out = await run({ explain: true });
    expect(out.next).toBeNull();
    expect(out.explain.excluded).toEqual([
      { id: 't-1', unsatisfiedBlockers: [{ id: 't-9', status: null, missing: true }] },
    ]);
    expect(stderrSpy.mock.calls.map((c: any) => c[0]).join('')).toMatch(/t-9 does not exist/);
  });

  it('caps ranking but reports the untruncated candidate count', async () => {
    for (let i = 0; i < EXPLAIN_RANKING_CAP + 2; i++) {
      try { await addCommand({ root: dir, args: { _: ['task'], title: `T${i}`, json: true } }); } catch {}
    }
    const { explain } = await run({ all: true, explain: true });
    expect(explain.ranking).toHaveLength(EXPLAIN_RANKING_CAP);
    expect(explain.candidateCount).toBe(EXPLAIN_RANKING_CAP + 2);
  });
});
