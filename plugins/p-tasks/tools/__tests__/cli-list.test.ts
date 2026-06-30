import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCommand, initFs, addCommand, setCommand } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-list-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try { await initFs({ root: dir }); } catch {}
  // t-1 with two sub-tasks, t-2 — exercises document order + mixed statuses.
  try { await addCommand({ root: dir, args: { _: ['task'], title: 'P', json: true } }); } catch {}
  try { await addCommand({ root: dir, args: { _: ['sub-task', 't-1'], title: 'S1', acceptance: 'AC1', files: 'a.ts', kind: 'code', origin: 'plan', json: true } }); } catch {}
  try { await addCommand({ root: dir, args: { _: ['sub-task', 't-1'], title: 'S2', kind: 'non-code', json: true } }); } catch {}
  try { await addCommand({ root: dir, args: { _: ['task'], title: 'Q', json: true } }); } catch {}
  try { await setCommand({ root: dir, args: { _: ['st-1'], status: 'done', json: true } }); } catch {}
  stdoutSpy.mockClear();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); exitSpy.mockRestore(); stdoutSpy.mockRestore(); });

describe('listCommand', () => {
  it('returns every item in document order with status', async () => {
    try { await listCommand({ root: dir, args: { _: [], json: true } }); } catch {}
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.items.map((i: any) => i.id)).toEqual(['t-1', 'st-1', 'st-2', 't-2']);
    expect(out.items.find((i: any) => i.id === 'st-1')).toMatchObject({
      status: 'done', acceptance: 'AC1', files: ['a.ts'], kind: 'code', origin: 'plan',
    });
  });
  it('scopes to a parent\'s sub-tasks when given a parent-id', async () => {
    try { await listCommand({ root: dir, args: { _: ['t-1'], json: true } }); } catch {}
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.items.map((i: any) => i.id)).toEqual(['st-1', 'st-2']);
  });
  it('errors with item-not-found for an unknown parent', async () => {
    try { await listCommand({ root: dir, args: { _: ['t-99'], json: true } }); } catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('item-not-found');
  });
});
