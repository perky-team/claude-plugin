import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ptasks-fs-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fs destination — read paths', () => {
  it('ensureStructure creates docs/tasks/tasks.yml with empty array', async () => {
    const dst = createFsDestination({ root: dir });
    await dst.ensureStructure();
    expect(existsSync(join(dir, 'docs', 'tasks', 'tasks.yml'))).toBe(true);
    const text = readFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'), 'utf-8');
    expect(text).toMatch(/tasks:\s*\[\]/);
  });
  it('ensureStructure is idempotent — does not overwrite existing content', async () => {
    mkdirSync(join(dir, 'docs', 'tasks'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'), 'tasks:\n  - id: t-1\n    title: keep\n    description: ""\n    status: todo\n    blockedBy: []\n    subTasks: []\n');
    const dst = createFsDestination({ root: dir });
    await dst.ensureStructure();
    expect(readFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'), 'utf-8')).toMatch(/id: t-1/);
  });
  it('listItems returns flat list with parentId on sub-tasks', async () => {
    mkdirSync(join(dir, 'docs', 'tasks'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'),
`tasks:
  - id: t-1
    title: A
    description: ""
    status: todo
    blockedBy: []
    subTasks:
      - id: st-1
        title: A1
        description: ""
        status: done
        blockedBy: []
`);
    const dst = createFsDestination({ root: dir });
    const items = await dst.listItems();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 't-1', type: 'task' });
    expect(items[1]).toMatchObject({ id: 'st-1', type: 'sub-task', parentId: 't-1' });
  });
  it('readItem returns task by id', async () => {
    mkdirSync(join(dir, 'docs', 'tasks'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'),
`tasks:
  - id: t-1
    title: A
    description: ""
    status: todo
    blockedBy: []
    subTasks: []
`);
    const dst = createFsDestination({ root: dir });
    const it = await dst.readItem('t-1');
    expect(it.title).toBe('A');
  });
  it('readItem throws item-not-found', async () => {
    mkdirSync(join(dir, 'docs', 'tasks'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'), 'tasks: []\n');
    const dst = createFsDestination({ root: dir });
    await expect(dst.readItem('t-99')).rejects.toThrow(/item-not-found/);
  });
});
