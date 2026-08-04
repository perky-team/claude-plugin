import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJobs, writeJobs, readState, readJobState, writeJobState, readConfig, paths } from '../lib/io.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-io-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('io', () => {
  it('readJobs returns empty defaults when missing', () => {
    expect(readJobs(root)).toEqual({ version: 1, defaults: {}, jobs: [], profiles: {} });
  });
  it('writeJobs round-trips through YAML', () => {
    const data = { version: 1, defaults: { timeoutSec: 900 }, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] };
    writeJobs(root, data);
    // profiles is reported as {} for a file that has no such block, and writeJobs does
    // not add an empty one — see the round-trip tests in jobs.test.ts.
    expect(readJobs(root)).toEqual({ ...data, profiles: {} });
  });
  it('job state round-trips through JSON', () => {
    const st = { lastRun: 111, lastExit: 0, pid: null };
    writeJobState(root, 'a', st);
    expect(readJobState(root, 'a')).toEqual(st);
  });
  it('readJobState returns null for a job with no state file', () => {
    expect(readJobState(root, 'missing')).toBeNull();
  });
  it('readState aggregates multiple per-job state files', () => {
    writeJobState(root, 'a', { lastRun: 111, lastExit: 0, pid: null });
    writeJobState(root, 'b', { lastRun: 222, lastExit: 1, pid: null });
    expect(readState(root)).toEqual({
      jobs: {
        a: { lastRun: 111, lastExit: 0, pid: null },
        b: { lastRun: 222, lastExit: 1, pid: null },
      },
    });
  });
  it('readConfig defaults nodeBin/claudeBin', () => {
    expect(readConfig(root)).toEqual({ nodeBin: 'node', claudeBin: 'claude' });
  });
  it('paths are under <root>/.pshed', () => {
    expect(paths(root).jobs).toBe(join(root, '.pshed', 'jobs.yml'));
    expect(paths(root).stateDir).toBe(join(root, '.pshed', 'state'));
  });
  it('readJobState tolerates a corrupt/truncated state file, and readState omits it', () => {
    mkdirSync(paths(root).stateDir, { recursive: true });
    writeFileSync(join(paths(root).stateDir, 'x.json'), '{ bad', 'utf-8');
    expect(readJobState(root, 'x')).toBeNull();
    expect(readState(root)).toEqual({ jobs: {} });
  });
  it('readConfig tolerates a corrupt config.json', () => {
    mkdirSync(paths(root).dir, { recursive: true });
    writeFileSync(paths(root).config, '{ not json', 'utf-8');
    expect(readConfig(root)).toEqual({ nodeBin: 'node', claudeBin: 'claude' });
  });
});
