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
  it('create-with-fields → walk via list → no-cascade → close all, end-to-end', () => {
    const SLUG = 'demo-feature';

    // --- Setup: the marker the bridge gate keys on is real + CLI-produced ---
    expect(ptasks(dir, ['init']).status).toBe(0);
    expect(existsSync(join(dir, 'docs', 'tasks', '.ptasks.json'))).toBe(true);

    // --- writing-plan recipe: task titled exactly <slug> + one sub-task per step,
    //     each carrying acceptance / files / kind / origin (the canonical fields) ---
    const task = ptasks(dir, ['add', 'task', '--title', SLUG]);
    expect(task.status).toBe(0);
    expect(task.out).toMatchObject({ id: 't-1', type: 'task', status: 'todo' });
    expect(task.out.title).toBe(SLUG); // join key: byte-for-byte == slug

    const steps = [
      { title: 'Step 1: scaffold', kind: 'code', acceptance: 'module exists' },
      { title: 'Step 2: implement', kind: 'code', acceptance: 'tests pass' },
      { title: 'Step 3: document', kind: 'non-code', acceptance: 'README updated' },
    ];
    for (const s of steps) {
      const r = ptasks(dir, ['add', 'sub-task', 't-1', '--title', s.title, '--kind', s.kind, '--acceptance', s.acceptance, '--origin', 'plan']);
      expect(r.status).toBe(0);
      expect(r.out).toMatchObject({ kind: s.kind, acceptance: s.acceptance, origin: 'plan' });
    }
    expect(readFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'), 'utf-8')).toContain(`title: ${SLUG}`);

    // --- executing-plan recipe: walk `list <parent>` in document order, classify by kind ---
    const walk = ptasks(dir, ['list', 't-1']).out.items;
    expect(walk.map((i: any) => i.id)).toEqual(['st-1', 'st-2', 'st-3']); // document order
    expect(walk.map((i: any) => i.kind)).toEqual(['code', 'code', 'non-code']);
    expect(walk.every((i: any) => i.status === 'todo')).toBe(true);

    // --- review recipe: an accepted finding is a sub-task with origin code-review:* ---
    const finding = ptasks(dir, ['add', 'sub-task', 't-1', '--title', 'Fix: null check', '--origin', 'code-review:blocker', '--acceptance', 'guards null']);
    expect(finding.out).toMatchObject({ id: 'st-4', origin: 'code-review:blocker' });
    // receiving-code-review reject path: close with a resolution instead of an inline note
    expect(ptasks(dir, ['set', 'st-4', '--status', 'done', '--resolution', 'rejected: false positive']).status).toBe(0);
    expect(ptasks(dir, ['list', 't-1']).out.items.find((i: any) => i.id === 'st-4'))
      .toMatchObject({ status: 'done', resolution: 'rejected: false positive' });

    // --- No-cascade guard (load-bearing for task-end) ---
    expect(ptasks(dir, ['set', 't-1', '--status', 'done']).status).toBe(0);
    const afterParentClose = ptasks(dir, ['list', 't-1']).out.items.filter((i: any) => ['st-1', 'st-2', 'st-3'].includes(i.id));
    // parent done, but its plan sub-tasks are STILL todo — closing a parent does
    // NOT cascade. If p-tasks ever adds cascade, this fails on purpose.
    expect(afterParentClose.every((i: any) => i.status === 'todo')).toBe(true);

    // --- Enumeration-command guard (defends the bridge prose) ---
    // `summary` returns ONLY done items — wrong for finding what's left to close.
    expect(ptasks(dir, ['summary', 't-1']).out.items.map((i: any) => i.id)).toEqual(['st-4']);
    // `list` returns ALL of them with status — the right tool to drive the close loop.
    const toClose = ptasks(dir, ['list', 't-1']).out.items.filter((i: any) => i.status !== 'done');
    expect(toClose.map((i: any) => i.id).sort()).toEqual(['st-1', 'st-2', 'st-3']);

    // --- task-end recipe: close each remaining sub-task surfaced by list ---
    for (const i of toClose) {
      expect(ptasks(dir, ['set', i.id, '--status', 'done']).status).toBe(0);
    }
    // fully-closed end state: every sub-task done
    expect(ptasks(dir, ['list', 't-1']).out.items.every((i: any) => i.status === 'done')).toBe(true);

    // --- Title-resolution sanity: the closed task resolves by slug, unambiguously ---
    expect(ptasks(dir, ['summary']).out.items).toEqual([{ id: 't-1', title: SLUG }]);
  });
});
