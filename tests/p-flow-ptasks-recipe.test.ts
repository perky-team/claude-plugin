// Executable spec for the p-flow → p-tasks bridge RECIPE.
//
// Task 5 proves the bridge *prose* is right; this proves the recipe the prose
// prescribes actually produces a correct p-tasks store, and pins the one
// external assumption `task-end` depends on: p-tasks has NO status cascade.
//
// It drives the REAL p-tasks CLI as a black box (exactly as the bridge does at
// runtime via the Skill tool) — no import of p-tasks internals. The cross-plugin
// reference is confined to this test; runtime stays decoupled (the bridge test
// forbids `ptasks.mjs` in any p-flow skill).

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { repoRoot } from './helpers.js';

// Spawn-heavy: each step is a cold `node` start (~100-300ms). Generous headroom.
vi.setConfig({ testTimeout: 30_000 });

const PTASKS_ROOT = resolve(repoRoot(), 'plugins', 'p-tasks');
const CLI = join(PTASKS_ROOT, 'tools', 'ptasks.mjs');

function ptasks(cwd: string, args: string[]) {
  const res = spawnSync(process.execPath, [CLI, ...args, '--json'], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PTASKS_ROOT },
  });
  return { status: res.status, out: res.stdout.trim() ? JSON.parse(res.stdout.trim()) : null };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pflow-ptasks-recipe-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('p-flow → p-tasks bridge recipe (real CLI)', () => {
  it('create → no-cascade → enumerate-open → close all, end-to-end', () => {
    const SLUG = 'demo-feature';

    // --- Setup: the marker the bridge gate keys on is real + CLI-produced ---
    expect(ptasks(dir, ['init']).status).toBe(0);
    expect(existsSync(join(dir, 'docs', 'tasks', '.ptasks.json'))).toBe(true);

    // --- writing-plan recipe: task titled exactly <slug> + one sub-task per step ---
    const task = ptasks(dir, ['add', 'task', '--title', SLUG]);
    expect(task.status).toBe(0);
    expect(task.out).toMatchObject({ id: 't-1', type: 'task', status: 'todo' });
    expect(task.out.title).toBe(SLUG); // join key: byte-for-byte == slug

    for (const title of ['Step 1: scaffold', 'Step 2: implement', 'Step 3: verify']) {
      expect(ptasks(dir, ['add', 'sub-task', 't-1', '--title', title]).status).toBe(0);
    }
    // title lands in the store verbatim
    expect(readFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'), 'utf-8')).toContain(`title: ${SLUG}`);

    // all four items open
    let open = ptasks(dir, ['next', '--all']).out.items;
    expect(open.map((i: any) => i.id).sort()).toEqual(['st-1', 'st-2', 'st-3', 't-1']);
    expect(open.every((i: any) => i.status !== 'done')).toBe(true);

    // --- No-cascade guard (load-bearing) ---
    expect(ptasks(dir, ['set', 't-1', '--status', 'done']).status).toBe(0);
    open = ptasks(dir, ['next', '--all']).out.items;
    const subtasks = open.filter((i: any) => i.parentId === 't-1');
    // parent done, but its three sub-tasks are STILL todo — closing a parent
    // does NOT cascade. If p-tasks ever adds cascade, this fails on purpose.
    expect(subtasks.map((i: any) => i.id).sort()).toEqual(['st-1', 'st-2', 'st-3']);
    expect(subtasks.every((i: any) => i.status === 'todo')).toBe(true);

    // --- Enumeration-command guard (defends the corrected bridge prose) ---
    // `summary` is the WRONG command to find open sub-tasks — it lists only done.
    expect(ptasks(dir, ['summary', 't-1']).out.items).toEqual([]);
    // `next --all` is the RIGHT one — it surfaces the open sub-tasks to close.
    expect(subtasks.length).toBe(3);

    // --- task-end recipe: close each open sub-task surfaced by next --all ---
    for (const id of ['st-1', 'st-2', 'st-3']) {
      expect(ptasks(dir, ['set', id, '--status', 'done']).status).toBe(0);
    }
    // fully-closed end state: nothing open, all sub-tasks done
    expect(ptasks(dir, ['next', '--all']).out.items).toEqual([]);
    expect(ptasks(dir, ['summary', 't-1']).out.items.map((i: any) => i.id).sort())
      .toEqual(['st-1', 'st-2', 'st-3']);

    // --- Title-resolution sanity: the closed task resolves by slug, unambiguously ---
    const summary = ptasks(dir, ['summary']).out.items;
    expect(summary).toEqual([{ id: 't-1', title: SLUG }]);
  });
});
