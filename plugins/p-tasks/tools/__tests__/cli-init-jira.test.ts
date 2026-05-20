import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWithArgs } from '../ptasks.mjs';

let dir: string;
let exitSpy: any;
let stdoutSpy: any;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-init-jira-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.env.PTASKS_JIRA_EMAIL = 'a@b.c';
  process.env.PTASKS_JIRA_TOKEN = 't';
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); exitSpy.mockRestore(); stdoutSpy.mockRestore(); });

describe('initWithArgs jira', () => {
  it('writes a jira-primary config when --primary=jira', async () => {
    const fake = async () => ({ status: 200, headers: {}, body: { key: 'PROJ' } });
    try { await initWithArgs({ root: dir, args: { primary: 'jira', site: 'https://x', project: 'PROJ', json: true }, transport: fake }); } catch (e: any) { expect(e.message).toBe('exit:0'); }
    const cfg = JSON.parse(readFileSync(join(dir, 'docs', 'tasks', '.ptasks.json'), 'utf-8'));
    expect(cfg.primary).toBe('jira');
    expect(cfg.destinations.jira.projectKey).toBe('PROJ');
  });
  it('writes fs+jira-mirror when --primary=fs --mirror=jira', async () => {
    const fake = async () => ({ status: 200, headers: {}, body: { key: 'PROJ' } });
    try { await initWithArgs({ root: dir, args: { primary: 'fs', mirror: 'jira', site: 'https://x', project: 'PROJ', json: true }, transport: fake }); } catch {}
    const cfg = JSON.parse(readFileSync(join(dir, 'docs', 'tasks', '.ptasks.json'), 'utf-8'));
    expect(cfg.primary).toBe('fs');
    expect(cfg.mirrors).toEqual(['jira']);
    expect(cfg.destinations.jira.kind).toBe('jira');
  });
});
