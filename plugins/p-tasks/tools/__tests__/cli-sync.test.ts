import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncCommand, initWithArgs, addCommand } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-sync-cli-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.env.PTASKS_JIRA_EMAIL = 'a@b.c';
  process.env.PTASKS_JIRA_TOKEN = 't';
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); exitSpy.mockRestore(); stdoutSpy.mockRestore(); });

describe('syncCommand', () => {
  it('returns empty array when no mirrors configured', async () => {
    try { await initWithArgs({ root: dir, args: {} }); } catch {}
    try { await addCommand({ root: dir, args: { _: ['task'], title: 'X', json: true } }); } catch {}
    stdoutSpy.mockClear();
    try { await syncCommand({ root: dir, args: { json: true } }); } catch {}
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out).toEqual({ mirrors: [] });
  });
});
