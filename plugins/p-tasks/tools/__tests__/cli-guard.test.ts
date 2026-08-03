// Real-CLI end-to-end for `ptasks guard`. The exit code IS the contract p-shed reads
// (0 launch / 75 deliberately quiet), so these tests spawn the actual process and
// assert on `status` — an in-process test with a mocked process.exit would prove
// nothing about what p-shed sees.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

vi.setConfig({ testTimeout: 30_000 });

const CLI = resolve(__dirname, '..', 'ptasks.mjs');

function ptasks(cwd: string, args: string[]) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: resolve(__dirname, '..', '..') },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-guard-'));
  expect(ptasks(dir, ['init', '--json']).status).toBe(0);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('CLI E2E: ptasks guard', () => {
  it('exits 75 on an empty backlog and says why on one line', () => {
    const r = ptasks(dir, ['guard']);
    expect(r.status).toBe(75);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(r.stdout.trim().length).toBeLessThanOrEqual(100);
  });

  it('exits 0 once there is an actionable item, naming it', () => {
    expect(ptasks(dir, ['add', 'task', '--title', 'A', '--json']).status).toBe(0);
    const r = ptasks(dir, ['guard']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('t-1');
  });

  it('exits 75 again once the only item is done', () => {
    ptasks(dir, ['add', 'task', '--title', 'A', '--json']);
    ptasks(dir, ['set', 't-1', '--status', 'done', '--json']);
    expect(ptasks(dir, ['guard']).status).toBe(75);
  });

  it('exits 75 when every open item is excluded by origin', () => {
    ptasks(dir, ['add', 'task', '--title', 'Q', '--origin', 'human:question', '--json']);
    expect(ptasks(dir, ['guard']).status).toBe(0);
    const r = ptasks(dir, ['guard', '--exclude-origin', 'human:']);
    expect(r.status).toBe(75);
    expect(r.stdout).toMatch(/excluded/);
  });

  it('accepts a repeated --exclude-origin', () => {
    ptasks(dir, ['add', 'task', '--title', 'Q', '--origin', 'human:question', '--json']);
    ptasks(dir, ['add', 'task', '--title', 'R', '--origin', 'code-review:low', '--json']);
    const r = ptasks(dir, ['guard', '--exclude-origin', 'human:', '--exclude-origin', 'code-review:']);
    expect(r.status).toBe(75);
  });

  it('still exits 0 when one excluded item sits next to an actionable one', () => {
    ptasks(dir, ['add', 'task', '--title', 'Q', '--origin', 'human:question', '--json']);
    ptasks(dir, ['add', 'task', '--title', 'W', '--json']);
    const r = ptasks(dir, ['guard', '--exclude-origin', 'human:']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('t-2');
  });

  it('--json keeps the same exit codes and prints a parseable envelope', () => {
    const quiet = ptasks(dir, ['guard', '--json']);
    expect(quiet.status).toBe(75);
    expect(JSON.parse(quiet.stdout)).toMatchObject({ action: 'guard', result: 'quiet', next: null });

    ptasks(dir, ['add', 'task', '--title', 'A', '--json']);
    const ready = ptasks(dir, ['guard', '--json']);
    expect(ready.status).toBe(0);
    const out = JSON.parse(ready.stdout);
    expect(out).toMatchObject({ action: 'guard', result: 'ready' });
    expect(out.next.id).toBe('t-1');
    expect(typeof out.reason).toBe('string');
  });

  it('rejects --exclude-origin with no value instead of silently ignoring it', () => {
    ptasks(dir, ['add', 'task', '--title', 'Q', '--origin', 'human:question', '--json']);
    const r = ptasks(dir, ['guard', '--exclude-origin']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/exclude-origin/);
  });

  it('is dispatchable — never reports an unknown command', () => {
    expect(ptasks(dir, ['guard']).stderr).not.toMatch(/unknown command/);
  });
});
