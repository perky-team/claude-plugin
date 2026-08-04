import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setJob, rmJob, slugify, ValidationError, jobFieldError, EFFORT_LEVELS } from '../lib/jobs.mjs';
import { readJobs, writeJobs, paths } from '../lib/io.mjs';

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
  it('persists model and maxConsecutiveFailures on create', () => {
    setJob(root, { id: 'a', schedule: '* * * * *', prompt: 'go', model: 'sonnet', maxConsecutiveFailures: 5 });
    const job = readJobs(root).jobs[0];
    expect(job.model).toBe('sonnet');
    expect(job.maxConsecutiveFailures).toBe(5);
  });
  it('persists model and maxConsecutiveFailures on update', () => {
    setJob(root, { id: 'a', schedule: '* * * * *', prompt: 'go' });
    setJob(root, { id: 'a', model: 'opus', maxConsecutiveFailures: 2 });
    const job = readJobs(root).jobs[0];
    expect(job.model).toBe('opus');
    expect(job.maxConsecutiveFailures).toBe(2);
  });
  it('persists effort on create and round-trips through read', () => {
    setJob(root, { id: 'a', schedule: '* * * * *', prompt: 'go', effort: 'high' });
    expect(readJobs(root).jobs[0].effort).toBe('high');
  });
  it('persists effort on update', () => {
    setJob(root, { id: 'a', schedule: '* * * * *', prompt: 'go' });
    setJob(root, { id: 'a', effort: 'xhigh' });
    expect(readJobs(root).jobs[0].effort).toBe('xhigh');
  });
  it('does not write effort when it is unset', () => {
    setJob(root, { id: 'a', schedule: '* * * * *', prompt: 'go' });
    expect('effort' in readJobs(root).jobs[0]).toBe(false);
  });
  it('rejects an invalid effort level', () => {
    expect(() => setJob(root, { id: 'a', schedule: '* * * * *', prompt: 'go', effort: 'bogus' })).toThrow(ValidationError);
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

describe('jobs.yml round trip', () => {
  it('set-job preserves a profiles: block instead of silently deleting it', () => {
    writeJobs(root, {
      version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '* * * * *', prompt: 'go' }],
      profiles: { eco: { a: { schedule: '0 */3 * * *' } } },
    });
    setJob(root, { id: 'a', schedule: '*/5 * * * *' });
    expect(readJobs(root).profiles).toEqual({ eco: { a: { schedule: '0 */3 * * *' } } });
  });

  it('rm-job preserves it too', () => {
    writeJobs(root, {
      version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '* * * * *', prompt: 'go' }, { id: 'b', schedule: '* * * * *', prompt: 'go' }],
      profiles: { eco: { a: { enabled: false } } },
    });
    rmJob(root, 'b');
    expect(readJobs(root).profiles).toEqual({ eco: { a: { enabled: false } } });
  });

  it('reports an absent profiles: block as {} and does not write an empty one', () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [] });
    expect(readJobs(root).profiles).toEqual({});
    expect(readFileSync(paths(root).jobs, 'utf-8')).not.toContain('profiles');
  });
});

describe('jobFieldError', () => {
  it('accepts valid values', () => {
    expect(jobFieldError('schedule', '*/5 * * * *')).toBeNull();
    expect(jobFieldError('effort', 'high')).toBeNull();
    expect(jobFieldError('timeoutSec', 60)).toBeNull();
    expect(jobFieldError('enabled', false)).toBeNull();
    expect(jobFieldError('model', 'sonnet')).toBeNull();
  });
  it('rejects invalid ones with setJob-identical wording', () => {
    expect(jobFieldError('effort', 'turbo')).toBe(`invalid effort: turbo (expected one of ${EFFORT_LEVELS.join(', ')})`);
    expect(jobFieldError('schedule', 'nope')).toMatch(/^invalid cron: /);
    expect(jobFieldError('timeoutSec', 0)).toMatch(/^invalid timeoutSec: /);
    expect(jobFieldError('enabled', 'yes')).toMatch(/^invalid enabled: /);
  });
  it('ignores fields it does not own', () => {
    expect(jobFieldError('prompt', 42)).toBeNull();
  });
});
