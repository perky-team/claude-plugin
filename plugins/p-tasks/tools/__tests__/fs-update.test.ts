import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ptasks-fs-update-'));
  const dst = createFsDestination({ root: dir });
  await dst.ensureStructure();
  await dst.createItem({ type: 'task', title: 'A', description: '', status: 'todo', blockedBy: [] });
  await dst.createItem({ type: 'sub-task', parentId: 't-1', title: 'S1', description: '', status: 'todo', blockedBy: [] });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fs destination — updateItem', () => {
  it('patches a single field, leaves others untouched', async () => {
    const dst = createFsDestination({ root: dir });
    const updated = await dst.updateItem('t-1', { status: 'in_progress' });
    expect(updated.status).toBe('in_progress');
    expect(updated.title).toBe('A');
  });
  it('updates sub-task', async () => {
    const dst = createFsDestination({ root: dir });
    const updated = await dst.updateItem('st-1', { title: 'renamed' });
    expect(updated.title).toBe('renamed');
    expect(updated.parentId).toBe('t-1');
  });
  it('replaces blockedBy fully', async () => {
    const dst = createFsDestination({ root: dir });
    await dst.updateItem('t-1', { blockedBy: ['st-1'] });
    const refetched = await dst.readItem('t-1');
    expect(refetched.blockedBy).toEqual(['st-1']);
  });
  it('merges jiraKeys without losing other mirror entries', async () => {
    const dst = createFsDestination({ root: dir });
    await dst.updateItem('t-1', { jiraKeys: { 'jira-prod': 'PROJ-1' } });
    await dst.updateItem('t-1', { jiraKeys: { 'jira-staging': 'STAGE-1' } });
    const after = await dst.readItem('t-1');
    expect(after.jiraKeys).toEqual({ 'jira-prod': 'PROJ-1', 'jira-staging': 'STAGE-1' });
  });
  it('throws item-not-found for unknown id', async () => {
    const dst = createFsDestination({ root: dir });
    await expect(dst.updateItem('t-99', { title: 'x' })).rejects.toMatchObject({ code: 'item-not-found' });
  });
});
