import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summaryCommand, initFs, addCommand, setCommand } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-summary-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try { await initFs({ root: dir }); } catch {}
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); exitSpy.mockRestore(); stdoutSpy.mockRestore(); });

describe('summaryCommand', () => {
  it('lists done top-level tasks without args', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'A', json: true } }); } catch {}
    try { await setCommand({ root: dir, args: { _: ['t-1'], status: 'done', json: true } }); } catch {}
    stdoutSpy.mockClear();
    try { await summaryCommand({ root: dir, args: { _: [], json: true } }); } catch {}
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.items).toEqual([{ id: 't-1', title: 'A' }]);
  });
  it('lists done sub-tasks of a task', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'P', json: true } }); } catch {}
    try { await addCommand({ root: dir, args: { _: ['sub-task', 't-1'], title: 'S', json: true } }); } catch {}
    try { await setCommand({ root: dir, args: { _: ['st-1'], status: 'done', json: true } }); } catch {}
    stdoutSpy.mockClear();
    try { await summaryCommand({ root: dir, args: { _: ['t-1'], json: true } }); } catch {}
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.items).toEqual([{ id: 'st-1', title: 'S' }]);
  });
  it('rejects unknown parent', async () => {
    stdoutSpy.mockClear();
    try { await summaryCommand({ root: dir, args: { _: ['t-99'], json: true } }); } catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('item-not-found');
  });
});
