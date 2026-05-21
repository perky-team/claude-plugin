// Real-CLI end-to-end: spawn `node ptasks.mjs <command>` against a temp git repo
// and assert on actual stdout/exit-code. Complements the in-process function tests
// that run the same code via direct imports.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(__dirname, '..', 'ptasks.mjs');

function ptasks(cwd: string, args: string[]) {
  const res = spawnSync(process.execPath, [CLI, ...args, '--json'], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: resolve(__dirname, '..', '..') },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function parseJson(s: string) {
  return JSON.parse(s.trim());
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-e2e-'));
  // We intentionally do NOT `git init` — findRoot falls back to cwd outside a git repo,
  // and that's the simpler path to exercise. (init does not require git.)
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('CLI E2E (FS path)', () => {
  it('init scaffolds the expected files', () => {
    const r = ptasks(dir, ['init']);
    expect(r.status).toBe(0);
    const out = parseJson(r.stdout);
    expect(out).toMatchObject({ ok: true, primary: 'fs', mirrors: [] });
    expect(existsSync(join(dir, 'docs', 'tasks', '.ptasks.json'))).toBe(true);
    expect(existsSync(join(dir, 'docs', 'tasks', 'tasks.yml'))).toBe(true);
    expect(existsSync(join(dir, 'docs', 'tasks', 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'rules', 'p-tasks.md'))).toBe(true);
  });

  it('init refuses on second invocation', () => {
    ptasks(dir, ['init']);
    const r = ptasks(dir, ['init']);
    expect(r.status).toBe(1);
    expect(parseJson(r.stdout).error.code).toBe('already-initialized');
  });

  it('full workflow: add → add sub-task → set status → next → summary', () => {
    expect(ptasks(dir, ['init']).status).toBe(0);

    // Create two top-level tasks
    let r = ptasks(dir, ['add', 'task', '--title', 'Build auth']);
    expect(r.status).toBe(0);
    expect(parseJson(r.stdout)).toMatchObject({ id: 't-1', type: 'task', title: 'Build auth', status: 'todo' });

    r = ptasks(dir, ['add', 'task', '--title', 'Wire CI', '--blocked-by', 't-1']);
    expect(r.status).toBe(0);
    expect(parseJson(r.stdout)).toMatchObject({ id: 't-2', blockedBy: ['t-1'] });

    // Sub-task under t-1
    r = ptasks(dir, ['add', 'sub-task', 't-1', '--title', 'Hash passwords']);
    expect(r.status).toBe(0);
    expect(parseJson(r.stdout)).toMatchObject({ id: 'st-1', type: 'sub-task', parentId: 't-1' });

    // Mark t-1 in_progress — should bubble to top of next
    r = ptasks(dir, ['set', 't-1', '--status', 'in_progress']);
    expect(r.status).toBe(0);
    expect(parseJson(r.stdout).status).toBe('in_progress');

    // next → t-1 (in_progress beats todo, and we have it)
    r = ptasks(dir, ['next']);
    expect(r.status).toBe(0);
    expect(parseJson(r.stdout).next.id).toBe('t-1');

    // Mark t-1 done — frees t-2; next should then be t-2
    r = ptasks(dir, ['set', 't-1', '--status', 'done']);
    expect(r.status).toBe(0);
    r = ptasks(dir, ['next']);
    expect(parseJson(r.stdout).next.id).toBe('t-2');

    // Summary: list done top-level tasks
    r = ptasks(dir, ['summary']);
    expect(r.status).toBe(0);
    expect(parseJson(r.stdout)).toEqual({ items: [{ id: 't-1', title: 'Build auth' }] });

    // Summary scoped to t-1: no done sub-tasks yet
    r = ptasks(dir, ['summary', 't-1']);
    expect(r.status).toBe(0);
    expect(parseJson(r.stdout)).toEqual({ items: [] });

    // Mark st-1 done — should appear in scoped summary
    ptasks(dir, ['set', 'st-1', '--status', 'done']);
    r = ptasks(dir, ['summary', 't-1']);
    expect(parseJson(r.stdout)).toEqual({ items: [{ id: 'st-1', title: 'Hash passwords' }] });
  });

  it('add rejects blocker-not-found with non-zero exit', () => {
    ptasks(dir, ['init']);
    const r = ptasks(dir, ['add', 'task', '--title', 'X', '--blocked-by', 't-99']);
    expect(r.status).toBe(1);
    expect(parseJson(r.stdout).error.code).toBe('blocker-not-found');
  });

  it('set rejects cycle creation', () => {
    ptasks(dir, ['init']);
    ptasks(dir, ['add', 'task', '--title', 'A']);
    ptasks(dir, ['add', 'task', '--title', 'B', '--blocked-by', 't-1']);
    const r = ptasks(dir, ['set', 't-1', '--add-blocker', 't-2']);
    expect(r.status).toBe(1);
    expect(parseJson(r.stdout).error.code).toBe('cycle-detected');
  });

  it('add sub-task rejects sub-task as parent (two-level enforcement)', () => {
    ptasks(dir, ['init']);
    ptasks(dir, ['add', 'task', '--title', 'P']);
    ptasks(dir, ['add', 'sub-task', 't-1', '--title', 'S1']);
    const r = ptasks(dir, ['add', 'sub-task', 'st-1', '--title', 'S2']);
    expect(r.status).toBe(1);
    expect(parseJson(r.stdout).error.code).toBe('parent-not-found');
  });

  it('sync returns empty mirrors array on default config', () => {
    ptasks(dir, ['init']);
    ptasks(dir, ['add', 'task', '--title', 'X']);
    const r = ptasks(dir, ['sync']);
    expect(r.status).toBe(0);
    expect(parseJson(r.stdout)).toEqual({ mirrors: [] });
  });

  it('--version prints the version string', () => {
    const r = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('unknown command exits 1 with stderr message', () => {
    const r = spawnSync(process.execPath, [CLI, 'nope'], { encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown command');
  });
});
