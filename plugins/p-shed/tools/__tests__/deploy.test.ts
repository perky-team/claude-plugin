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
import { readDeployOwner, deployOwnerPath, writeDeployOwner } from '../lib/owner.mjs';
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

// C1: reproduces, at the lib level, the two-deploy scenario from the final review —
// deploy A owns run/DEPLOY and holds a live pause; deploy B must refuse outright instead
// of overwriting A's ownership and running its own command alongside A's. See
// cli-deploy-e2e.test.ts for the same scenario driven through two real OS processes.
describe('C1 — refusing a concurrent deploy', () => {
  it('refuses to start when run/DEPLOY names a LIVE pid, and touches nothing', async () => {
    writeDeployOwner(root, { pid: 555, scope: 'global', reason: 'other deploy', now: 0 });
    const order: string[] = [];
    const res = await runDeploy(base({
      pid: 4242,
      deps: {
        spawn: fakeSpawn(0), isAlive: (pid: number) => pid === 555, now: () => 0, sleep: async () => {},
        onStep: (s: string) => order.push(s),
      },
    }));
    expect(res.outcome).toBe('busy');
    expect(res.exit).toBe(2);
    expect(res.holder).toEqual({ pid: 555, reason: 'other deploy' });
    expect(res.message).toMatch(/555/);
    expect(res.message).toMatch(/other deploy/);
    // Minor: pids get recycled (aggressively on Windows), so a killed deploy's pid can be
    // reassigned to an unrelated live process — the refusal above then fires forever, and
    // with cron torn down (`pshed stop`) nothing sweeps run/DEPLOY to clear it. The
    // message must name the recovery, not just the diagnosis.
    expect(res.message).toMatch(/\.pshed[\\/]run[\\/]DEPLOY/);
    // No wait, pause, run, or release was even attempted — this is a refusal, not a
    // dance that unwound partway through.
    expect(order).toEqual([]);
    expect(readDeployOwner(root)).toMatchObject({ pid: 555, reason: 'other deploy' });
    expect(readGlobalPause(root)).toBeNull();
  });

  it('still overwrites a DEAD owner — a crashed deploy must not wedge every later one', async () => {
    writeDeployOwner(root, { pid: 555, scope: 'global', reason: 'crashed', now: 0 });
    const res = await runDeploy(base({
      pid: 4242,
      deps: { spawn: fakeSpawn(0), isAlive: (pid: number) => pid !== 555, now: () => 0, sleep: async () => {} },
    }));
    expect(res.outcome).toBe('ok');
    expect(readDeployOwner(root)).toBeNull(); // released normally, back to nothing
  });

  it("release() never removes run/DEPLOY once it no longer names this run's own pid", async () => {
    // onStep('release') fires BEFORE release() executes (see lib/deploy.mjs), so this
    // simulates another deploy having already claimed ownership by the moment this run's
    // OWN release runs — exactly the t=1.0 step in the review's timeline, where B's exit
    // used to delete A's still-live ownership.
    const res = await runDeploy(base({
      pid: 4242,
      deps: {
        spawn: fakeSpawn(0), isAlive: () => false, now: () => 0, sleep: async () => {},
        onStep: (s: string) => { if (s === 'release') writeDeployOwner(root, { pid: 9999, scope: 'global', now: 0 }); },
      },
    }));
    expect(res.outcome).toBe('ok');
    expect(existsSync(deployOwnerPath(root))).toBe(true);
    expect(readDeployOwner(root)).toMatchObject({ pid: 9999 });
  });
});

// I1: an operator `pause` landing on a deploy-origin marker WHILE the deploy is still
// running must take ownership of it, so the deploy's own release (which only clears a
// marker still carrying ITS origin) leaves the human's halt in place.
describe('I1 — an operator pause during a deploy survives the deploy release', () => {
  it('global scope: writeGlobalPause takes ownership mid-run, and release leaves it alone', async () => {
    let duringRun: any = null;
    const res = await runDeploy(base({
      deps: {
        spawn: async () => {
          // The operator's own call shape (lib/pause.mjs / pshed.mjs's `pause` command
          // never passes an explicit origin for the global marker).
          duringRun = writeGlobalPause(root, { reason: 'incident: stop everything' });
          return { exit: 0, signal: null };
        },
        isAlive: () => false, now: () => 0, sleep: async () => {},
      },
    }));
    expect(res.outcome).toBe('ok');
    expect(duringRun).toMatchObject({ alreadyPaused: true, tookOwnership: true, origin: 'operator', reason: 'incident: stop everything' });
    const after = readGlobalPause(root);
    expect(after).not.toBeNull();
    expect(after).toMatchObject({ origin: 'operator', reason: 'incident: stop everything' });
    // The result must say so too — this is the whole point of the fix. Before it, the
    // takeover was silently dropped: dropOwnPauses() skipped the removal (correctly) but
    // never reported having done so, so the caller had no way to learn the "release" it
    // just claimed left a halt standing.
    expect(res.takenOver).toEqual([{ scope: 'global', origin: 'operator', reason: 'incident: stop everything' }]);
  });

  it('group scope: writePause takes ownership mid-run, and release leaves it alone', async () => {
    let duringRun: any = null;
    const res = await runDeploy(base({
      group: 'hft',
      deps: {
        spawn: async () => {
          duringRun = writePause(root, 'worker', { reason: 'incident: stop everything', origin: 'operator' });
          return { exit: 0, signal: null };
        },
        isAlive: () => false, now: () => 0, sleep: async () => {},
      },
    }));
    expect(res.outcome).toBe('ok');
    expect(duringRun).toMatchObject({ alreadyPaused: true, tookOwnership: true, origin: 'operator', reason: 'incident: stop everything' });
    expect(readPauseRecord(root, 'worker')).toEqual({ origin: 'operator', reason: 'incident: stop everything' });
    // 'chat' was placed by this deploy and never touched by anyone else, so it is released
    // normally; only 'worker' shows up as taken over.
    expect(res.takenOver).toEqual([{ scope: 'job', id: 'worker', origin: 'operator', reason: 'incident: stop everything' }]);
    expect(existsSync(pausePath(root, 'chat'))).toBe(false);
  });
});

describe('M7 — the undo-and-retry path rate-limits its retry', () => {
  it('sleeps pollMs between an undo and the next wait instead of spinning', async () => {
    let phase = 0;
    let sleepCalls = 0;
    const res = await runDeploy(base({
      pollMs: 250,
      deps: {
        spawn: fakeSpawn(0),
        isAlive: () => phase === 1, // pid 111 is "alive" only during the first re-check
        now: () => 0,
        sleep: async () => { sleepCalls++; },
        onStep: (s: string) => {
          if (s === 'pause' && phase === 0) { writePid(root, 'worker', 111); phase = 1; }
          if (s === 'recheck' && phase === 1) { phase = 2; }
        },
      },
    }));
    expect(res.outcome).toBe('ok');
    expect(res.attempts).toBe(2);
    // Neither waitForIdle call in this run ever finds a live holder at its own check (the
    // straggler only ever shows up at the deploy-level recheck), so its only source is the
    // undo-and-retry sleep this fix adds.
    expect(sleepCalls).toBe(1);
  });
});
