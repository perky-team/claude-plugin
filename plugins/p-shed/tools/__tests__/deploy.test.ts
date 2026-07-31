// The dance is indivisible, and its ORDER is the point. Measured on the live system:
// pausing before waiting for idle silenced the read-only chat jobs for the entire
// remaining run of a 30-minute worker (phone dark for 20 minutes).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDeploy } from '../lib/deploy.mjs';
import { readGlobalPause, writeGlobalPause, globalPausePath } from '../lib/pause.mjs';
import { writePause, readPauseRecord, pausePath } from '../lib/breaker.mjs';
import { readDeployOwner, deployOwnerPath } from '../lib/owner.mjs';
import { writePid } from '../lib/pids.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-deploy-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const JOBS = [
  { id: 'worker', schedule: '* * * * *', prompt: 'go', concurrencyGroup: 'hft' },
  { id: 'chat', schedule: '* * * * *', prompt: 'go', concurrencyGroup: 'hft' },
];

// A spawn stub returning a chosen exit code. It deliberately does NOT record the call —
// step order is recorded by onStep alone, so the two can never double-count.
const fakeSpawn = (exit: number) => async () => ({ exit, signal: null });

const base = (over: any = {}) => ({
  root, jobs: JOBS, defaults: {}, reason: 'prompt update',
  timeoutMs: 60_000, pollMs: 1000, cmd: 'git', args: ['pull'], pid: 4242,
  deps: { spawn: fakeSpawn(0), isAlive: () => false, now: () => 0, sleep: async () => {} },
  ...over,
});

describe('order of operations', () => {
  it('waits for idle BEFORE pausing, then runs, then releases', async () => {
    const order: string[] = [];
    const res = await runDeploy(base({
      deps: {
        spawn: fakeSpawn(0), isAlive: () => false, now: () => 0, sleep: async () => {},
        onStep: (s: string) => order.push(s),
      },
    }));
    expect(order).toEqual(['wait', 'pause', 'recheck', 'run', 'release']);
    expect(res.outcome).toBe('ok');
    expect(res.exit).toBe(0);
  });

  it('leaves nothing behind: no pause, no run/DEPLOY', async () => {
    await runDeploy(base());
    expect(readGlobalPause(root)).toBeNull();
    expect(existsSync(deployOwnerPath(root))).toBe(false);
  });

  it('records the owner in run/DEPLOY while the command runs', async () => {
    let seen: any = null;
    await runDeploy(base({
      deps: {
        spawn: async () => { seen = readDeployOwner(root); return { exit: 0, signal: null }; },
        isAlive: () => false, now: () => 0, sleep: async () => {},
      },
    }));
    expect(seen).toMatchObject({ pid: 4242, scope: 'global', reason: 'prompt update' });
  });

  it('the pause it places carries the deploy origin and the reason', async () => {
    let marker: any = null;
    await runDeploy(base({
      deps: {
        spawn: async () => { marker = readGlobalPause(root); return { exit: 0, signal: null }; },
        isAlive: () => false, now: () => 0, sleep: async () => {},
      },
    }));
    expect(marker).toMatchObject({ origin: 'deploy', reason: 'prompt update' });
  });
});

describe('the race between waiting and pausing', () => {
  it('undoes its own pause and retries when a job launches in the gap', async () => {
    // Idle on the first wait; a holder appears once the pause is placed, then goes away.
    let phase = 0;
    const order: string[] = [];
    const res = await runDeploy(base({
      deps: {
        spawn: fakeSpawn(0),
        // pid 111 is "alive" only during the first re-check
        isAlive: () => phase === 1,
        now: () => 0, sleep: async () => {},
        onStep: (s: string) => {
          order.push(s);
          if (s === 'pause' && phase === 0) { writePid(root, 'worker', 111); phase = 1; }
          if (s === 'recheck' && phase === 1) { phase = 2; }
        },
      },
    }));
    expect(order).toEqual(['wait', 'pause', 'recheck', 'undo', 'wait', 'pause', 'recheck', 'run', 'release']);
    expect(res.attempts).toBe(2);
    expect(res.outcome).toBe('ok');
    expect(readGlobalPause(root)).toBeNull();
  });
});

describe('release is unconditional', () => {
  it('releases and propagates the code when the command fails', async () => {
    const res = await runDeploy(base({ deps: { spawn: fakeSpawn(17), isAlive: () => false, now: () => 0, sleep: async () => {} } }));
    expect(res.exit).toBe(17);
    expect(readGlobalPause(root)).toBeNull();
    expect(existsSync(deployOwnerPath(root))).toBe(false);
  });

  it('releases when the command throws', async () => {
    const boom = async () => { throw new Error('spawn exploded'); };
    await expect(runDeploy(base({ deps: { spawn: boom, isAlive: () => false, now: () => 0, sleep: async () => {} } }))).rejects.toThrow('spawn exploded');
    expect(readGlobalPause(root)).toBeNull();
    expect(existsSync(deployOwnerPath(root))).toBe(false);
  });

  it('a real removal failure does not destroy a successful result, and the rest of cleanup still runs', async () => {
    // rmSync({force:true}) swallows "already gone" (ENOENT), not "is a directory". Swap
    // the 'worker' pause file for a directory of the same name right after it's placed,
    // so release()'s removePause('worker') hits a genuine, non-ENOENT fs failure.
    const res = await runDeploy(base({
      group: 'hft',
      deps: {
        spawn: fakeSpawn(0), isAlive: () => false, now: () => 0, sleep: async () => {},
        onStep: (s: string) => {
          if (s === 'recheck') {
            rmSync(pausePath(root, 'worker'), { force: true });
            mkdirSync(pausePath(root, 'worker'));
          }
        },
      },
    }));
    expect(res.outcome).toBe('ok');
    expect(res.exit).toBe(0);
    expect(res.releaseErrors.length).toBeGreaterThan(0);
    expect(res.releaseErrors[0]).toMatch(/removePause\(worker\)/);
    // The failing removal didn't stop the rest: chat's pause and the deploy owner are
    // both gone despite worker's directory still sitting where its pause file was.
    expect(existsSync(pausePath(root, 'chat'))).toBe(false);
    expect(existsSync(deployOwnerPath(root))).toBe(false);
    rmSync(pausePath(root, 'worker'), { recursive: true, force: true });
  });
});

describe('a pre-existing pause is preserved', () => {
  it('does not remove a global operator pause it walked into', async () => {
    writeGlobalPause(root, { reason: 'halted by hand' });
    const res = await runDeploy(base());
    expect(res.ownedGlobal).toBe(false);
    expect(res.preserved).toEqual([{ scope: 'global' }]);
    expect(readGlobalPause(root)).not.toBeNull();
    expect(readGlobalPause(root)!.reason).toBe('halted by hand');
  });

  it('group scope: pauses only the members it actually placed', async () => {
    writePause(root, 'chat', { reason: 'by hand', origin: 'operator' });
    const res = await runDeploy(base({ group: 'hft' }));
    expect(res.scope).toBe('group');
    expect(res.pausedIds).toEqual(['worker']);
    expect(res.preserved).toEqual([{ scope: 'job', id: 'chat', origin: 'operator' }]);
    expect(existsSync(pausePath(root, 'worker'))).toBe(false);          // released
    expect(readPauseRecord(root, 'chat')).toEqual({ origin: 'operator', reason: 'by hand' });
  });
});

describe('cancellation', () => {
  it('unwinds a wait that was cancelled, pausing and running nothing', async () => {
    writePid(root, 'worker', 111);
    let clock = 0;
    let polls = 0;
    const order: string[] = [];
    const res = await runDeploy(base({
      timeoutMs: 600_000,
      deps: {
        spawn: fakeSpawn(0), isAlive: () => true,
        now: () => clock, sleep: async (ms: number) => { clock += ms; },
        isAborted: () => ++polls >= 2,
        onStep: (s: string) => order.push(s),
      },
    }));
    expect(res.outcome).toBe('aborted');
    expect(order).not.toContain('pause');
    expect(order).not.toContain('run');
    expect(existsSync(globalPausePath(root))).toBe(false);
    expect(existsSync(deployOwnerPath(root))).toBe(false);
  });
});

describe('timeout', () => {
  it('pauses nothing and runs nothing when the wait times out', async () => {
    writePid(root, 'worker', 111);
    let clock = 0;
    const order: string[] = [];
    const res = await runDeploy(base({
      timeoutMs: 3000,
      deps: {
        spawn: fakeSpawn(0), isAlive: () => true,
        now: () => clock, sleep: async (ms: number) => { clock += ms; },
        onStep: (s: string) => order.push(s),
      },
    }));
    expect(res.outcome).toBe('timeout');
    expect(res.holders).toEqual([{ id: 'worker', pid: 111 }]);
    expect(order).not.toContain('pause');
    expect(order).not.toContain('run');
    expect(existsSync(globalPausePath(root))).toBe(false);
    expect(existsSync(deployOwnerPath(root))).toBe(false);
  });
});
