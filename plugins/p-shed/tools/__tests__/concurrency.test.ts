import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGroup, findGroupHolder } from '../lib/concurrency.mjs';
import { writePid } from '../lib/pids.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-conc-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('resolveGroup', () => {
  it("uses the job's own group", () => {
    expect(resolveGroup({ id: 'a', concurrencyGroup: 'tree' }, {})).toBe('tree');
  });

  it('inherits defaults.concurrencyGroup when the job sets no field', () => {
    expect(resolveGroup({ id: 'a' }, { concurrencyGroup: 'tree' })).toBe('tree');
  });

  it('a per-job value overrides the default', () => {
    expect(resolveGroup({ id: 'a', concurrencyGroup: 'chat' }, { concurrencyGroup: 'tree' })).toBe('chat');
  });

  it('an explicit null on the job beats the default — unconstrained', () => {
    expect(resolveGroup({ id: 'a', concurrencyGroup: null }, { concurrencyGroup: 'tree' })).toBeNull();
    expect(resolveGroup({ id: 'a', concurrencyGroup: '' }, { concurrencyGroup: 'tree' })).toBeNull();
  });

  it('is null when neither the job nor defaults set one (current behavior)', () => {
    expect(resolveGroup({ id: 'a' }, {})).toBeNull();
    expect(resolveGroup({ id: 'a' }, undefined as never)).toBeNull();
  });

  it('ignores a non-string group instead of throwing', () => {
    expect(resolveGroup({ id: 'a', concurrencyGroup: 42 as never }, {})).toBeNull();
    expect(resolveGroup({ id: 'a', concurrencyGroup: true as never }, { concurrencyGroup: 'tree' })).toBeNull();
  });
});

// Liveness comes from the per-job pidfiles that already exist — no group pidfile,
// which would invent a phantom job for `status` and `stop` (see CLAUDE.md).
describe('findGroupHolder', () => {
  const jobs = [
    { id: 'worker', concurrencyGroup: 'tree' },
    { id: 'tidy', concurrencyGroup: 'tree' },
    { id: 'chat', concurrencyGroup: 'chat' },
    { id: 'probe' },
  ];
  const held = (id: string, pid: number) => writePid(root, id, pid);
  const isAlive = (pid: number) => pid === 111;

  it('reports the live groupmate holding the group', () => {
    held('worker', 111);
    expect(findGroupHolder({ root, job: jobs[1], jobs, defaults: {}, isAlive }))
      .toEqual({ id: 'worker', pid: 111, group: 'tree' });
  });

  it('ignores a live job in a different group', () => {
    held('chat', 111);
    expect(findGroupHolder({ root, job: jobs[0], jobs, defaults: {}, isAlive })).toBeNull();
  });

  it('ignores a stale pidfile whose pid is dead', () => {
    held('worker', 222); // not alive per the probe
    expect(findGroupHolder({ root, job: jobs[1], jobs, defaults: {}, isAlive })).toBeNull();
  });

  it('never reports the job itself as its own holder', () => {
    held('worker', 111);
    expect(findGroupHolder({ root, job: jobs[0], jobs, defaults: {}, isAlive })).toBeNull();
  });

  it('an ungrouped job is unconstrained even while others are live', () => {
    held('worker', 111);
    expect(findGroupHolder({ root, job: jobs[3], jobs, defaults: {}, isAlive })).toBeNull();
  });

  it('groups jobs that inherit the same default', () => {
    held('worker', 111);
    const inherited = [{ id: 'worker' }, { id: 'tidy' }];
    expect(findGroupHolder({ root, job: inherited[1], jobs: inherited, defaults: { concurrencyGroup: 'tree' }, isAlive }))
      .toMatchObject({ id: 'worker', group: 'tree' });
  });

  it('returns the first holder in jobs.yml order (deterministic, no fairness scheme)', () => {
    held('worker', 111);
    held('tidy', 111);
    const third = { id: 'third', concurrencyGroup: 'tree' };
    expect(findGroupHolder({ root, job: third, jobs: [...jobs, third], defaults: {}, isAlive })?.id).toBe('worker');
  });

  it('returns null when the job has no pidfile at all', () => {
    expect(findGroupHolder({ root, job: jobs[1], jobs, defaults: {}, isAlive })).toBeNull();
  });
});
