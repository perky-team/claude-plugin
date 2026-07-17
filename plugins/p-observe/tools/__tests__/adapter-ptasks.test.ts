import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadConfig, paths } from '../lib/config.mjs';
import { createPtasksAdapter, readTaskStates } from '../lib/adapters/ptasks.mjs';

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

  it('does not throw or advance baseline on a torn read', () => {
    const cfg = loadConfig(root); const p = paths(root, cfg);
    writeTasks(p, TASKS);
    const events: any[] = [];
    const a = createPtasksAdapter({ root, paths: p, cfg, emit: (e) => events.push(e) });
    a.backfill();
    writeTasks(p, '{ half writ'); // torn/partial
    expect(() => a._diffNow()).not.toThrow();
    expect(events).toEqual([]); // baseline unchanged
    writeTasks(p, TASKS.replace('status: todo', 'status: done'));
    a._diffNow();
    expect(events).toHaveLength(1); // diff still correct against the original baseline
  });
});
