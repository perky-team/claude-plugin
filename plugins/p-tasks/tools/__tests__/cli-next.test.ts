import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextCommand, initFs, addCommand, setCommand } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-next-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try { await initFs({ root: dir }); } catch {}
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); exitSpy.mockRestore(); stdoutSpy.mockRestore(); });

describe('nextCommand', () => {
  it('returns null when nothing actionable', async () => {
    stdoutSpy.mockClear();
    try { await nextCommand({ root: dir, args: { _: [], json: true } }); } catch {}
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out).toEqual({ next: null });
  });
  it('returns top-1 by default and the full list with --all', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'A', json: true } }); } catch {}
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'B', json: true } }); } catch {}
    try { await setCommand({ root: dir, args: { _: ['t-1'], status: 'in_progress', json: true } }); } catch {}
    stdoutSpy.mockClear();
    try { await nextCommand({ root: dir, args: { _: [], json: true } }); } catch {}
    const one = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(one.next.id).toBe('t-1');

    stdoutSpy.mockClear();
    try { await nextCommand({ root: dir, args: { _: [], all: true, json: true } }); } catch {}
    const all = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(all.items.map((i: any) => i.id)).toEqual(['t-1', 't-2']);
  });
});
