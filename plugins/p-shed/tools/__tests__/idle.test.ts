// "Idle" is answered from p-shed's OWN pidfiles, never from pgrep. Measured on the live
// system: `ssh host "pgrep -f 'claude -p …'"` matches the ssh command itself and reports
// the loop busy forever, and `pkill -f 'until ! pgrep'` killed its own shell.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listHolders, waitForIdle } from '../lib/idle.mjs';
import { writePid } from '../lib/pids.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-idle-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const JOBS = [
  { id: 'worker', schedule: '* * * * *', prompt: 'go', concurrencyGroup: 'hft' },
  { id: 'chat', schedule: '* * * * *', prompt: 'go', concurrencyGroup: 'hft' },
  { id: 'other', schedule: '* * * * *', prompt: 'go' },
];

describe('listHolders', () => {
  it('is empty when no pidfile exists', () => {
    expect(listHolders({ root, jobs: JOBS, isAlive: () => true })).toEqual([]);
  });

  it('global scope reports every live job, dead pids dropped', () => {
    writePid(root, 'worker', 111);
    writePid(root, 'other', 222);
    const holders = listHolders({ root, jobs: JOBS, isAlive: (pid: number) => pid === 111 });
    expect(holders).toEqual([{ id: 'worker', pid: 111 }]);
  });

  it('group scope ignores a live job outside the group', () => {
    writePid(root, 'other', 222);
    expect(listHolders({ root, jobs: JOBS, group: 'hft', isAlive: () => true })).toEqual([]);
  });

  it('group scope includes a member inheriting the group from defaults', () => {
    const jobs = [{ id: 'inherits', schedule: '* * * * *', prompt: 'go' }];
    writePid(root, 'inherits', 333);
    const holders = listHolders({ root, jobs, defaults: { concurrencyGroup: 'hft' }, group: 'hft', isAlive: () => true });
    expect(holders).toEqual([{ id: 'inherits', pid: 333 }]);
  });

  it('global scope counts a pidfile whose job is no longer in jobs.yml', () => {
    writePid(root, 'deleted-job', 444);
    expect(listHolders({ root, jobs: JOBS, isAlive: () => true })).toEqual([{ id: 'deleted-job', pid: 444 }]);
  });
});

describe('waitForIdle', () => {
  it('returns immediately when nothing is running', async () => {
    const res = await waitForIdle({ root, jobs: JOBS, timeoutMs: 5000, isAlive: () => true, now: () => 0, sleep: async () => {} });
    expect(res.idle).toBe(true);
    expect(res.holders).toEqual([]);
  });

  it('blocks while a holder is live, then proceeds when it exits', async () => {
    writePid(root, 'worker', 111);
    let clock = 0;
    let liveChecks = 0;
    const isAlive = () => { liveChecks++; return liveChecks <= 2; }; // dies on the 3rd poll
    const res = await waitForIdle({
      root, jobs: JOBS, timeoutMs: 60_000, pollMs: 1000,
      isAlive, now: () => clock, sleep: async (ms: number) => { clock += ms; },
    });
    expect(res.idle).toBe(true);
    expect(res.waitedMs).toBe(2000);
  });

  it('times out and names the holder without pausing anything', async () => {
    writePid(root, 'worker', 111);
    let clock = 0;
    const res = await waitForIdle({
      root, jobs: JOBS, timeoutMs: 3000, pollMs: 1000,
      isAlive: () => true, now: () => clock, sleep: async (ms: number) => { clock += ms; },
    });
    expect(res.idle).toBe(false);
    expect(res.holders).toEqual([{ id: 'worker', pid: 111 }]);
    expect(res.waitedMs).toBeGreaterThanOrEqual(3000);
  });

  it('checks once even with a zero timeout (idle is still idle)', async () => {
    const res = await waitForIdle({ root, jobs: JOBS, timeoutMs: 0, isAlive: () => true, now: () => 0, sleep: async () => {} });
    expect(res.idle).toBe(true);
  });

  it('stops waiting when cancelled, and says so', async () => {
    // Ctrl+C during a 30-minute wait must not be ignored: the caller has to be able to
    // unwind and release, not sit in the poll loop until the timeout.
    writePid(root, 'worker', 111);
    let clock = 0;
    let polls = 0;
    const res = await waitForIdle({
      root, jobs: JOBS, timeoutMs: 600_000, pollMs: 1000,
      isAlive: () => true, now: () => clock, sleep: async (ms: number) => { clock += ms; },
      isAborted: () => ++polls >= 3,
    });
    expect(res).toMatchObject({ idle: false, aborted: true });
    expect(res.holders).toEqual([{ id: 'worker', pid: 111 }]);
  });
});
