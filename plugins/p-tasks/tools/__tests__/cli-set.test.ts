import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setCommand, initFs, addCommand } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-set-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try { await initFs({ root: dir }); } catch {}
  try { await addCommand({ root: dir, args: { _: ['task'], title: '1', json: true } }); } catch {}
  try { await addCommand({ root: dir, args: { _: ['task'], title: '2', json: true } }); } catch {}
  try { await addCommand({ root: dir, args: { _: ['task'], title: '3', 'blocked-by': 't-2', json: true } }); } catch {}
  stdoutSpy.mockClear();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  exitSpy.mockRestore();
  stdoutSpy.mockRestore();
});

describe('setCommand', () => {
  it('updates status', async () => {
    try { await setCommand({ root: dir, args: { _: ['t-1'], status: 'in_progress', json: true } }); } catch (e: any) { expect(e.message).toBe('exit:0'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.status).toBe('in_progress');
  });
  it('rejects invalid status', async () => {
    try { await setCommand({ root: dir, args: { _: ['t-1'], status: 'wontfix', json: true } }); } catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('invalid-status');
  });
  it('rejects unknown id', async () => {
    try { await setCommand({ root: dir, args: { _: ['t-99'], title: 'x', json: true } }); } catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('item-not-found');
  });
  it('--add-blocker rejects cycles', async () => {
    // t-3 blockedBy t-2 (initial). Now add blocker t-3 to t-2 → t-2 → t-3 → t-2 cycle.
    try { await setCommand({ root: dir, args: { _: ['t-2'], 'add-blocker': 't-3', json: true } }); } catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('cycle-detected');
  });
  it('--remove-blocker is incremental', async () => {
    try { await setCommand({ root: dir, args: { _: ['t-3'], 'remove-blocker': 't-2', json: true } }); } catch {}
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.blockedBy).toEqual([]);
  });
  it('--blocked-by replaces fully', async () => {
    try { await setCommand({ root: dir, args: { _: ['t-3'], 'blocked-by': 't-1,t-2', json: true } }); } catch {}
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.blockedBy.sort()).toEqual(['t-1', 't-2']);
  });
  it('sets the optional work-item fields including --resolution', async () => {
    try {
      await setCommand({ root: dir, args: {
        _: ['t-1'], acceptance: 'AC', files: 'x.ts,y.ts', kind: 'non-code',
        origin: 'task-review:nit', resolution: 'rejected: cosmetic', json: true,
      } });
    } catch (e: any) { expect(e.message).toBe('exit:0'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out).toMatchObject({
      acceptance: 'AC', files: ['x.ts', 'y.ts'], kind: 'non-code',
      origin: 'task-review:nit', resolution: 'rejected: cosmetic',
    });
  });
  it('rejects an invalid --kind', async () => {
    try { await setCommand({ root: dir, args: { _: ['t-1'], kind: 'prose', json: true } }); } catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('invalid-kind');
  });
});
