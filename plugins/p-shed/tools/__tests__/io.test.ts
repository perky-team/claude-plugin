import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJobs, writeJobs, readState, writeState, readConfig, paths } from '../lib/io.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-io-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('io', () => {
  it('readJobs returns empty defaults when missing', () => {
    expect(readJobs(root)).toEqual({ version: 1, defaults: {}, jobs: [] });
  });
  it('writeJobs round-trips through YAML', () => {
    const data = { version: 1, defaults: { timeoutSec: 900 }, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] };
    writeJobs(root, data);
    expect(readJobs(root)).toEqual(data);
  });
  it('state round-trips through JSON', () => {
    writeState(root, { jobs: { a: { lastRun: 111, lastExit: 0, pid: null } } });
    expect(readState(root)).toEqual({ jobs: { a: { lastRun: 111, lastExit: 0, pid: null } } });
  });
  it('readConfig defaults nodeBin/claudeBin', () => {
    expect(readConfig(root)).toEqual({ nodeBin: 'node', claudeBin: 'claude' });
  });
  it('paths are under <root>/.pshed', () => {
    expect(paths(root).jobs).toBe(join(root, '.pshed', 'jobs.yml'));
  });
  it('readState tolerates a corrupt/truncated state.json', () => {
    mkdirSync(paths(root).dir, { recursive: true });
    writeFileSync(paths(root).state, '{ not json', 'utf-8');
    expect(readState(root)).toEqual({ jobs: {} });
  });
  it('readConfig tolerates a corrupt config.json', () => {
    mkdirSync(paths(root).dir, { recursive: true });
    writeFileSync(paths(root).config, '{ not json', 'utf-8');
    expect(readConfig(root)).toEqual({ nodeBin: 'node', claudeBin: 'claude' });
  });
});
