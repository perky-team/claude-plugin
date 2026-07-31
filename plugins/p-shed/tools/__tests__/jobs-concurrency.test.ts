import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setJob, ValidationError } from '../lib/jobs.mjs';
import { readJobs } from '../lib/io.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-jobsconc-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const base = { id: 'a', schedule: '* * * * *', prompt: 'go' };
const jobA = () => readJobs(root).jobs.find((j: { id: string }) => j.id === 'a')!;

describe('setJob concurrencyGroup schema', () => {
  it('persists concurrencyGroup on create', () => {
    setJob(root, { ...base, concurrencyGroup: 'tree' });
    expect(jobA()).toMatchObject({ concurrencyGroup: 'tree' });
  });

  it('round-trips through an update, preserving unrelated fields', () => {
    setJob(root, { ...base, model: 'sonnet', guard: 'check' });
    setJob(root, { id: 'a', concurrencyGroup: 'tree' });
    expect(jobA()).toMatchObject({ concurrencyGroup: 'tree', model: 'sonnet', guard: 'check', prompt: 'go' });
  });

  it('changes the group on a later update', () => {
    setJob(root, { ...base, concurrencyGroup: 'tree' });
    setJob(root, { id: 'a', concurrencyGroup: 'chat' });
    expect(jobA().concurrencyGroup).toBe('chat');
  });

  // '' is the clear sentinel, consistent with --guard "". It must write an explicit
  // null rather than deleting the key: deleting would silently re-inherit
  // defaults.concurrencyGroup, which is the opposite of what "clear" means here.
  it('concurrencyGroup: "" writes an explicit null so the job escapes defaults', () => {
    setJob(root, { ...base, concurrencyGroup: 'tree' });
    setJob(root, { id: 'a', concurrencyGroup: '' });
    const j = jobA();
    expect('concurrencyGroup' in j).toBe(true);
    expect(j.concurrencyGroup).toBeNull();
  });

  it('creating a job with concurrencyGroup: "" records the explicit null', () => {
    setJob(root, { ...base, concurrencyGroup: '' });
    expect(jobA().concurrencyGroup).toBeNull();
  });

  it('leaves the field absent when it is never set', () => {
    setJob(root, base);
    expect('concurrencyGroup' in jobA()).toBe(false);
  });

  it('rejects a non-string group (a bare --concurrency-group flag arrives as true)', () => {
    expect(() => setJob(root, { ...base, concurrencyGroup: true as never })).toThrow(ValidationError);
    expect(() => setJob(root, { ...base, concurrencyGroup: 7 as never })).toThrow(ValidationError);
  });
});
