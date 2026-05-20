import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-fs-create-'));
  const dst = createFsDestination({ root: dir });
  await dst.ensureStructure();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fs destination — createItem', () => {
  it('assigns t-1 on empty file', async () => {
    const dst = createFsDestination({ root: dir });
    const created = await dst.createItem({ type: 'task', title: 'A', description: '', status: 'todo', blockedBy: [] });
    expect(created.id).toBe('t-1');
    expect(created.title).toBe('A');
    expect(created.status).toBe('todo');
  });
  it('monotonically advances to t-2, t-3 on subsequent creates', async () => {
    const dst = createFsDestination({ root: dir });
    expect((await dst.createItem({ type: 'task', title: 'A', description:'', status:'todo', blockedBy: [] })).id).toBe('t-1');
    expect((await dst.createItem({ type: 'task', title: 'B', description:'', status:'todo', blockedBy: [] })).id).toBe('t-2');
    expect((await dst.createItem({ type: 'task', title: 'C', description:'', status:'todo', blockedBy: [] })).id).toBe('t-3');
  });
  it('assigns st-1 for first sub-task under existing task', async () => {
    const dst = createFsDestination({ root: dir });
    await dst.createItem({ type: 'task', title: 'P', description:'', status:'todo', blockedBy: [] });
    const st = await dst.createItem({ type: 'sub-task', parentId: 't-1', title: 'S', description:'', status:'todo', blockedBy: [] });
    expect(st.id).toBe('st-1');
    expect(st.parentId).toBe('t-1');
  });
  it('throws parent-not-found for unknown parentId', async () => {
    const dst = createFsDestination({ root: dir });
    await expect(dst.createItem({ type: 'sub-task', parentId: 't-99', title: 'S', description:'', status:'todo', blockedBy: [] }))
      .rejects.toMatchObject({ code: 'parent-not-found' });
  });
  it('throws parent-not-found when parentId is a sub-task (two-level enforcement)', async () => {
    const dst = createFsDestination({ root: dir });
    await dst.createItem({ type: 'task', title: 'P', description:'', status:'todo', blockedBy: [] });
    await dst.createItem({ type: 'sub-task', parentId: 't-1', title: 'S1', description:'', status:'todo', blockedBy: [] });
    await expect(dst.createItem({ type: 'sub-task', parentId: 'st-1', title: 'S2', description:'', status:'todo', blockedBy: [] }))
      .rejects.toMatchObject({ code: 'parent-not-found' });
  });
  it('persists the new item to tasks.yml', async () => {
    const dst = createFsDestination({ root: dir });
    await dst.createItem({ type: 'task', title: 'Persist', description: '', status: 'todo', blockedBy: [] });
    expect(readFileSync(join(dir, 'docs', 'tasks', 'tasks.yml'), 'utf-8')).toMatch(/Persist/);
  });
});
