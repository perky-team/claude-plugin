import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCommand, initFs } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-add-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try { await initFs({ root: dir }); } catch {}
  stdoutSpy.mockClear();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  exitSpy.mockRestore();
  stdoutSpy.mockRestore();
});

describe('addCommand', () => {
  it('adds a task and returns id=t-1', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'Login', json: true } }); } catch (e: any) { expect(e.message).toBe('exit:0'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.id).toBe('t-1');
    expect(out.title).toBe('Login');
  });
  it('adds a sub-task under existing parent', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'P', json: true } }); } catch {}
    stdoutSpy.mockClear();
    try { await addCommand({ root: dir, args: { _: ['sub-task', 't-1'], title: 'S', json: true } }); } catch {}
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.id).toBe('st-1');
    expect(out.parentId).toBe('t-1');
  });
  it('rejects unknown blocker', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'X', 'blocked-by': 't-99', json: true } }); }
    catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('blocker-not-found');
  });
  it('rejects an invalid --status (parity with set) and writes nothing', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'X', status: 'frobnicate', json: true } }); }
    catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('invalid-status');
    // nothing persisted
    const doc = readFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'), 'utf-8');
    expect(doc).not.toContain('frobnicate');
  });
  it('threads --acceptance / --files / --kind / --origin into the created item', async () => {
    try {
      await addCommand({ root: dir, args: {
        _: ['task'], title: 'F', acceptance: 'tests pass',
        files: 'a.ts,b.ts', kind: 'code', origin: 'plan', json: true,
      } });
    } catch (e: any) { expect(e.message).toBe('exit:0'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out).toMatchObject({ acceptance: 'tests pass', files: ['a.ts', 'b.ts'], kind: 'code', origin: 'plan' });
  });
  it('rejects an invalid --kind and writes nothing', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'X', kind: 'prose', json: true } }); }
    catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('invalid-kind');
    expect(readFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'), 'utf-8')).not.toContain('prose');
  });
  it('happy path: chain blocked-by', async () => {
    try { await addCommand({ root: dir, args: { _: ['task'], title: '1', json: true } }); } catch {}
    try { await addCommand({ root: dir, args: { _: ['task'], title: '2', 'blocked-by': 't-1', json: true } }); } catch {}
    try { await addCommand({ root: dir, args: { _: ['task'], title: '3', 'blocked-by': 't-2', json: true } }); } catch {}
    stdoutSpy.mockClear();
    try { await addCommand({ root: dir, args: { _: ['task'], title: '4', 'blocked-by': 't-3', json: true } }); } catch (e: any) { expect(e.message).toBe('exit:0'); }
  });
});
