import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCommand } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
let stderrSpy: any;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-cfg-'));
  mkdirSync(join(dir, 'docs', 'tasks'), { recursive: true });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  exitSpy.mockRestore();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

describe('config error handling', () => {
  it('malformed JSON yields a clean config-invalid envelope, not a stack trace', async () => {
    writeFileSync(join(dir, 'docs', 'tasks', '.ptasks.json'), '{ not json', 'utf-8');
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'X', json: true } }); }
    catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('config-invalid');
    // the JSON contract is honored — nothing leaked to stderr
    expect(stderrSpy.mock.calls).toEqual([]);
  });
  it('structurally invalid config (primary points at a missing destination) is config-invalid', async () => {
    writeFileSync(
      join(dir, 'docs', 'tasks', '.ptasks.json'),
      JSON.stringify({ primary: 'jira', mirrors: [], destinations: { fs: { kind: 'fs' } } }),
      'utf-8',
    );
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'X', json: true } }); }
    catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('config-invalid');
  });
});
