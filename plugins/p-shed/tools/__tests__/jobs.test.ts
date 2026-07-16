import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setJob, rmJob, slugify, ValidationError } from '../lib/jobs.mjs';
import { readJobs } from '../lib/io.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-jobs-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('slugify', () => {
  it('kebab-cases and truncates', () => {
    expect(slugify('Take the Next Item!')).toBe('take-the-next-item');
  });
});

describe('setJob', () => {
  it('rejects a bad cron expression', () => {
    expect(() => setJob(root, { schedule: 'nope', prompt: 'x' })).toThrow(ValidationError);
  });
  it('creates a job with a generated id and defaults enabled=true', () => {
    const res = setJob(root, { schedule: '*/15 * * * *', prompt: 'Do the thing' });
    expect(res.created).toBe(true);
    const jobs = readJobs(root).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: 'do-the-thing', schedule: '*/15 * * * *', enabled: true, prompt: 'Do the thing' });
  });
  it('updates an existing job in place', () => {
    setJob(root, { id: 'a', schedule: '* * * * *', prompt: 'first' });
    const res = setJob(root, { id: 'a', schedule: '0 * * * *', prompt: 'first', enabled: false });
    expect(res.created).toBe(false);
    const jobs = readJobs(root).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: 'a', schedule: '0 * * * *', enabled: false });
  });
  it('partial update retains existing fields', () => {
    setJob(root, { id: 'a', schedule: '* * * * *', prompt: 'first' });
    const res = setJob(root, { id: 'a', enabled: false });
    expect(res.created).toBe(false);
    const jobs = readJobs(root).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: 'a', schedule: '* * * * *', prompt: 'first', enabled: false });
  });
  it('new job missing prompt throws ValidationError', () => {
    expect(() => setJob(root, { schedule: '* * * * *' })).toThrow(ValidationError);
  });
  it('slug collision yields distinct ids', () => {
    const res1 = setJob(root, { schedule: '* * * * *', prompt: 'Do the Thing!' });
    const res2 = setJob(root, { schedule: '* * * * *', prompt: 'Do The Thing' });
    expect(res1.id).toBe('do-the-thing');
    expect(res2.id).toBe('do-the-thing-2');
    const jobs = readJobs(root).jobs;
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.id)).toContain('do-the-thing');
    expect(jobs.map((j) => j.id)).toContain('do-the-thing-2');
  });
});

describe('rmJob', () => {
  it('removes and reports found/not-found', () => {
    setJob(root, { id: 'a', schedule: '* * * * *', prompt: 'x' });
    expect(rmJob(root, 'a')).toBe(true);
    expect(rmJob(root, 'a')).toBe(false);
    expect(readJobs(root).jobs).toHaveLength(0);
  });
});
