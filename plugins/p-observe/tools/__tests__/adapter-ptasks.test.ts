import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadConfig, paths } from '../lib/config.mjs';
import { createPtasksAdapter, readTaskStates, readTasks } from '../lib/adapters/ptasks.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pobs-ptasks-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const TASKS = `version: 1
tasks:
  - id: TASK-1
    title: A
    status: todo
  - id: TASK-2
    title: B
    status: in_progress
`;

function writeTasks(p: any, text: string) { mkdirSync(dirname(p.tasksFile), { recursive: true }); writeFileSync(p.tasksFile, text); }

describe('readTaskStates', () => {
  it('extracts id->status pairs tolerantly', () => {
    const m = readTaskStates(TASKS);
    expect(m.get('TASK-1')).toBe('todo');
    expect(m.get('TASK-2')).toBe('in_progress');
  });
});

describe('ptasks adapter diff', () => {
  it('emits task.status on a status change', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    writeTasks(p, TASKS);
    const events: any[] = [];
    const a = createPtasksAdapter({ root, paths: p, cfg, emit: (e) => events.push(e) });
    a.backfill(); // seed snapshot, no events
    expect(events).toEqual([]);
    writeTasks(p, TASKS.replace('status: todo', 'status: done'));
    a._diffNow(); // test seam: run the diff synchronously
    expect(events).toEqual([
      expect.objectContaining({ plugin: 'p-tasks', kind: 'task.status', entity: 'TASK-1', summary: 'todo → done' }),
    ]);
  });

  it('does not throw or advance baseline on a torn read (non-YAML-shaped)', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    writeTasks(p, TASKS);
    const events: any[] = [];
    const a = createPtasksAdapter({ root, paths: p, cfg, emit: (e) => events.push(e) });
    a.backfill();
    writeTasks(p, '{ half writ'); // torn/partial, no trailing newline
    expect(() => a._diffNow()).not.toThrow();
    expect(events).toEqual([]); // baseline unchanged
    writeTasks(p, TASKS.replace('status: todo', 'status: done'));
    a._diffNow();
    expect(events).toHaveLength(1); // diff still correct against the ORIGINAL baseline
  });

  it('does not emit a spurious task.removed on a YAML-shaped mid-field truncation', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    writeTasks(p, TASKS);
    const events: any[] = [];
    const a = createPtasksAdapter({ root, paths: p, cfg, emit: (e) => events.push(e) });
    a.backfill(); // seeds baseline with TASK-1 + TASK-2
    // Mid-field truncation: cut at "stat" before "us: in_progress", no trailing newline.
    const torn = `version: 1
tasks:
  - id: TASK-1
    title: A
    status: todo
  - id: TASK-2
    title: B
    stat`;
    writeTasks(p, torn);
    expect(() => a._diffNow()).not.toThrow();
    expect(events).toEqual([]); // no spurious task.removed for TASK-2, baseline unchanged
    writeTasks(p, TASKS.replace('status: todo', 'status: done'));
    a._diffNow();
    expect(events).toHaveLength(1); // diff still correct against the ORIGINAL baseline
  });

  it('still emits task.removed for a real, complete removal', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    writeTasks(p, TASKS);
    const events: any[] = [];
    const a = createPtasksAdapter({ root, paths: p, cfg, emit: (e) => events.push(e) });
    a.backfill(); // seeds baseline with TASK-1 + TASK-2
    const complete = `version: 1
tasks:
  - id: TASK-1
    title: A
    status: todo
`; // complete file (ends with newline) that legitimately omits TASK-2
    writeTasks(p, complete);
    a._diffNow();
    expect(events).toEqual([
      expect.objectContaining({ plugin: 'p-tasks', kind: 'task.removed', entity: 'TASK-2' }),
    ]);
  });
});

const TASKS_FULL = `version: 1
tasks:
  - id: TASK-1
    title: Add login
    description: |-
      Wire the OAuth flow
      end to end
    status: todo
`;

describe('readTasks', () => {
  it('captures status, title, and the first description line', () => {
    const m = readTasks(TASKS_FULL);
    expect(m.get('TASK-1')).toMatchObject({ status: 'todo', title: 'Add login', description: 'Wire the OAuth flow' });
  });
  it('readTaskStates stays back-compatible (id -> status)', () => {
    expect(readTaskStates(TASKS_FULL).get('TASK-1')).toBe('todo');
  });
});

describe('ptasks adapter tasks snapshot', () => {
  it('status() exposes title/description per task', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    writeTasks(p, TASKS_FULL);
    const a = createPtasksAdapter({ root, paths: p, cfg, emit: () => {} });
    a.backfill();
    expect(a.status().tasks['TASK-1']).toMatchObject({ title: 'Add login', description: 'Wire the OAuth flow', status: 'todo' });
  });
});
