import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setJob, ValidationError } from '../lib/jobs.mjs';
import { readJobs } from '../lib/io.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-jobsguard-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const base = { id: 'a', schedule: '* * * * *', prompt: 'go' };
const jobA = () => readJobs(root).jobs.find((j: { id: string }) => j.id === 'a')!;

describe('setJob guard schema', () => {
  it('persists guard and guardTimeoutSec on create', () => {
    setJob(root, { ...base, guard: 'pchat guard', guardTimeoutSec: 120 });
    expect(jobA()).toMatchObject({ guard: 'pchat guard', guardTimeoutSec: 120 });
  });

  it('round-trips through an update, preserving unrelated fields', () => {
    setJob(root, { ...base, model: 'sonnet' });
    setJob(root, { id: 'a', guard: 'check' });
    expect(jobA()).toMatchObject({ guard: 'check', model: 'sonnet', prompt: 'go' });
  });

  it('guard: "" clears guard AND guardTimeoutSec (resolution A6)', () => {
    setJob(root, { ...base, guard: 'check', guardTimeoutSec: 60 });
    setJob(root, { id: 'a', guard: '' });
    const j = jobA();
    expect(j.guard).toBeUndefined();
    expect(j.guardTimeoutSec).toBeUndefined();
  });

  it('creating a job with guard: "" simply omits the field', () => {
    setJob(root, { ...base, guard: '' });
    expect(jobA().guard).toBeUndefined();
  });

  it('rejects a non-string guard (bare --guard flag arrives as true)', () => {
    expect(() => setJob(root, { ...base, guard: true as never })).toThrow(ValidationError);
  });

  it.each([0, -5, NaN])('rejects guardTimeoutSec = %s', (v) => {
    expect(() => setJob(root, { ...base, guardTimeoutSec: v as number })).toThrow(ValidationError);
  });
});
