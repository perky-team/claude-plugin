import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from '../lib/tick.mjs';
import { writeJobs, writeJobState, readState, paths } from '../lib/io.mjs';
import { pausePath, resetBreaker } from '../lib/breaker.mjs';

const MIN = 60000;
const NOW = new Date(2026, 6, 29, 9, 0).getTime();

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-tickguard-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const guardJob = (jobExtra: Record<string, unknown> = {}, defaults: Record<string, unknown> = { maxConsecutiveFailures: 3 }) => {
  writeJobs(root, { version: 1, defaults, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go', guard: 'check', ...jobExtra }] });
};
const seed = (extra: Record<string, unknown> = {}) =>
  writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null, ...extra });

const gr = (outcome: string, extra: Record<string, unknown> = {}) => ({
  outcome,
  exit: outcome === 'pass' ? 0 : outcome === 'quiet' ? 75 : 1,
  timedOut: false, durationMs: 3, out: '', err: '', ...extra,
});

function fakeDeps(overrides: Record<string, unknown> = {}) {
  return {
    runJob: vi.fn(async () => ({ pid: 123, exit: 0, timedOut: false, durationMs: 5, out: '', err: '' })),
    runGuard: vi.fn(async () => gr('pass')),
    appendLog: vi.fn(),
    rotateLogs: vi.fn(),
    isPidAlive: vi.fn(() => false),
    writePid: vi.fn(),
    removePid: vi.fn(),
    ...overrides,
  };
}

describe('tick + guard', () => {
  it('guard pass -> launched; log record has guarded: true; guard counter reset; lastGuard recorded', async () => {
    guardJob();
    seed({ consecutiveGuardFailures: 2 });
    const deps = fakeDeps();
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual([{ id: 'a', action: 'launched', exit: 0, timedOut: false }]);
    expect(deps.appendLog).toHaveBeenCalledOnce();
    expect((deps.appendLog as any).mock.calls[0][1]).toMatchObject({ outcome: 'success', guarded: true });
    const st = readState(root).jobs.a;
    expect(st.consecutiveGuardFailures).toBe(0);
    expect(st.lastGuard).toMatchObject({ at: NOW, outcome: 'pass', exit: 0 });
  });

  it('an unguarded launch log record has NO guarded flag (bit-for-bit unchanged)', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    seed();
    const deps = fakeDeps();
    await tick({ root, now: NOW, deps });
    expect(deps.runGuard).not.toHaveBeenCalled();
    expect((deps.appendLog as any).mock.calls[0][1].guarded).toBeUndefined();
  });

  it('guard quiet -> silent skip: slot consumed, no launch, NO history log line, run-failure counter untouched', async () => {
    guardJob();
    seed({ consecutiveFailures: 2 });
    const deps = fakeDeps({ runGuard: vi.fn(async () => gr('quiet')) });
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual([{ id: 'a', action: 'guard-quiet' }]);
    expect(deps.runJob).not.toHaveBeenCalled();
    expect(deps.appendLog).not.toHaveBeenCalled(); // log-noise policy: quiet is state-only
    const st = readState(root).jobs.a;
    expect(st.lastRun).toBe(NOW);                  // schedule slot consumed
    expect(st.consecutiveFailures).toBe(2);        // run counter untouched
    expect(st.consecutiveGuardFailures).toBe(0);   // quiet proves the guard healthy
    expect(st.lastGuard).toMatchObject({ outcome: 'quiet', exit: 75 });
  });

  it('guard error -> skip + increment guard counter + history log line with raw tail', async () => {
    guardJob();
    seed();
    const deps = fakeDeps({ runGuard: vi.fn(async () => gr('error', { exit: 2, err: 'guard broke' })) });
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual([{ id: 'a', action: 'guard-error', exit: 2, timedOut: false }]);
    expect(deps.runJob).not.toHaveBeenCalled();
    expect(deps.appendLog).toHaveBeenCalledOnce();
    expect((deps.appendLog as any).mock.calls[0][1]).toMatchObject({ job: 'a', outcome: 'guard-error', exit: 2, raw: 'guard broke' });
    const st = readState(root).jobs.a;
    expect(st.consecutiveGuardFailures).toBe(1);
    expect(st.lastRun).toBe(NOW);
    expect(st.breakerTripped).toBeUndefined();
  });

  it('maxConsecutiveFailures guard errors trip the breaker; later ticks skip WITHOUT invoking the guard', async () => {
    guardJob({}, { maxConsecutiveFailures: 2 });
    seed();
    const runGuard = vi.fn(async () => gr('error'));
    const deps = fakeDeps({ runGuard });
    await tick({ root, now: NOW, deps });
    await tick({ root, now: NOW + MIN, deps });
    const st = readState(root).jobs.a;
    expect(st.breakerTripped).toBe(true);
    expect(st.breakerReason).toBe('guard exit 1');
    const r3 = await tick({ root, now: NOW + 2 * MIN, deps });
    expect(r3).toEqual([{ id: 'a', action: 'skipped-breaker', reason: 'guard exit 1' }]);
    expect(runGuard).toHaveBeenCalledTimes(2); // not on the tripped tick
  });

  it('a guard timeout trips with breakerReason "guard timeout"', async () => {
    guardJob({}, { maxConsecutiveFailures: 1 });
    seed();
    const deps = fakeDeps({ runGuard: vi.fn(async () => gr('error', { exit: null, timedOut: true })) });
    await tick({ root, now: NOW, deps });
    expect(readState(root).jobs.a.breakerReason).toBe('guard timeout');
  });

  // Counter separation — the §1.3 argument, encoded:
  it('run failures survive quiet slots and still trip (quiet resets ONLY the guard counter)', async () => {
    guardJob({}, { maxConsecutiveFailures: 3 });
    seed({ consecutiveFailures: 2 });
    const deps = fakeDeps({ runGuard: vi.fn(async () => gr('quiet')) });
    await tick({ root, now: NOW, deps });                          // quiet slot
    expect(readState(root).jobs.a.consecutiveFailures).toBe(2);    // survived
    const deps2 = fakeDeps({ runJob: vi.fn(async () => ({ pid: 1, exit: 1, timedOut: false, durationMs: 5, out: 'panic', err: '' })) });
    await tick({ root, now: NOW + MIN, deps: deps2 });
    const st = readState(root).jobs.a;
    expect(st.consecutiveFailures).toBe(3);
    expect(st.breakerTripped).toBe(true);
  });

  it('guard blips separated by quiets never accumulate', async () => {
    guardJob({}, { maxConsecutiveFailures: 2 });
    seed();
    const blip = fakeDeps({ runGuard: vi.fn(async () => gr('error')) });
    const quiet = fakeDeps({ runGuard: vi.fn(async () => gr('quiet')) });
    await tick({ root, now: NOW, deps: blip });
    await tick({ root, now: NOW + MIN, deps: quiet });
    await tick({ root, now: NOW + 2 * MIN, deps: blip });
    const st = readState(root).jobs.a;
    expect(st.consecutiveGuardFailures).toBe(1); // reset by the quiet in between
    expect(st.breakerTripped).toBeUndefined();
  });

  // Ordering: no guard invocation when a prior gate already decided.
  it('does not run the guard on the baseline tick, when paused, breaker-tripped, pid-alive, or not due', async () => {
    guardJob();
    const runGuard = vi.fn(async () => gr('pass'));

    // baseline (no state yet)
    expect(await tick({ root, now: NOW, deps: fakeDeps({ runGuard }) })).toEqual([{ id: 'a', action: 'baselined' }]);

    // paused
    seed();
    mkdirSync(paths(root).runDir, { recursive: true });
    writeFileSync(pausePath(root, 'a'), 'stop', 'utf-8');
    await tick({ root, now: NOW, deps: fakeDeps({ runGuard }) });
    rmSync(pausePath(root, 'a'), { force: true });

    // breaker-tripped
    seed({ breakerTripped: true, breakerReason: 'x' });
    await tick({ root, now: NOW, deps: fakeDeps({ runGuard }) });

    // pid alive
    seed({ pid: 777 });
    await tick({ root, now: NOW, deps: fakeDeps({ runGuard, isPidAlive: vi.fn(() => true) }) });

    // not due
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '0 0 1 1 *', enabled: true, prompt: 'go', guard: 'check' }] });
    seed();
    await tick({ root, now: NOW, deps: fakeDeps({ runGuard }) });

    expect(runGuard).not.toHaveBeenCalled();
  });

  it('reset-breaker clears the guard counter and a guard-tripped breaker', async () => {
    guardJob();
    seed({ consecutiveGuardFailures: 3, breakerTripped: true, breakerReason: 'guard exit 1', breakerAt: NOW });
    resetBreaker(root, 'a');
    const st = readState(root).jobs.a;
    expect(st.breakerTripped).toBeUndefined();
    expect(st.consecutiveGuardFailures ?? 0).toBe(0);
    expect(st.consecutiveFailures).toBe(0);
  });
});
