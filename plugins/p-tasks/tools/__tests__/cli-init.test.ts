import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initFs } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-init-fs-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  exitSpy.mockRestore();
  stdoutSpy.mockRestore();
});

describe('initFs', () => {
  it('writes config, tasks.yml, CLAUDE.md, and the rule', async () => {
    try { await initFs({ root: dir }); } catch (e: any) { expect(e.message).toBe('exit:0'); }
    expect(existsSync(join(dir, 'docs', 'tasks', '.ptasks.json'))).toBe(true);
    expect(existsSync(join(dir, 'docs', 'tasks', 'tasks.yml'))).toBe(true);
    expect(existsSync(join(dir, 'docs', 'tasks', 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'rules', 'p-tasks.md'))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(dir, 'docs', 'tasks', '.ptasks.json'), 'utf-8'));
    expect(cfg.primary).toBe('fs');
  });
  it('refuses if .ptasks.json already exists', async () => {
    mkdirSync(join(dir, 'docs', 'tasks'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'tasks', '.ptasks.json'), '{}');
    try { await initFs({ root: dir }); } catch (e: any) { expect(e.message).toBe('exit:1'); }
    const out = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(out.error.code).toBe('already-initialized');
  });
});
