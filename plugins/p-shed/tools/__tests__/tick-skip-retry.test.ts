// A quota/overload skip must not consume the job's slot.
//
// The skip path exists to say "this was not the job's fault", and proves it by refusing to
// touch the failure counter or the breaker. Advancing `lastRun` contradicted that: the
// measured incident is a `20 6 * * *` job that came back `api-overload` at 09:05 and was
// therefore not due again until 06:20 the NEXT morning — a transient API blip cost a full
// day. See docs/requests/05-pshed-skip-consumes-sparse-slot.md.
//
// Leaving `lastRun` alone is only half the fix; the other half is not hammering a quota
// that is known to be exhausted, which is what `retryNotBefore` bounds.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from '../lib/tick.mjs';
import { writeJobs, writeJobState, readState } from '../lib/io.mjs';
import { SKIP_BACKOFF_BASE_MS, SKIP_BACKOFF_MAX_MS } from '../lib/backoff.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-skip-retry-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// 2026-08-04 09:05 local — the incident's clock.
const NOW = new Date(2026, 7, 4, 9, 5).getTime();
const YESTERDAY_SLOT = new Date(2026, 7, 3, 6, 20).getTime();

function fakeDeps(overrides = {}) {
  return {
    runJob: vi.fn(async () => ({ pid: 123, exit: 0, timedOut: false, durationMs: 5 })),
    appendLog: vi.fn(),
    rotateLogs: vi.fn(),
    isPidAlive: vi.fn(() => false),
    writePid: vi.fn(),
    removePid: vi.fn(),
    ...overrides,
  };
}

const overloadRun = (out = '', err = 'API Error: 529 overloaded_error') =>
  vi.fn(async () => ({ pid: 1, exit: 1, timedOut: false, durationMs: 5, out, err }));
const limitRun = (out: string) =>
  vi.fn(async () => ({ pid: 1, exit: 1, timedOut: false, durationMs: 5, out, err: '' }));

/** The incident's job: daily at 06:20, last ran at yesterday's slot. */
function dailyJob(schedule = '20 6 * * *') {
  writeJobs(root, { version: 1, defaults: { maxConsecutiveFailures: 2 }, jobs: [{ id: 'a', schedule, enabled: true, prompt: 'go' }] });
  writeJobState(root, 'a', { lastRun: YESTERDAY_SLOT, lastExit: 0, pid: null, consecutiveFailures: 0 });
}

function minutelyJob() {
  writeJobs(root, { version: 1, defaults: { maxConsecutiveFailures: 2 }, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
  writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null, consecutiveFailures: 0 });
}

describe('a quota/overload skip leaves the slot unconsumed', () => {
  it('does not advance lastRun — the whole defect', async () => {
    dailyJob();
    await tick({ root, now: NOW, deps: fakeDeps({ runJob: overloadRun() }) });
    expect(readState(root).jobs.a.lastRun).toBe(YESTERDAY_SLOT);
  });

  it('records when it may retry, and counts the skip', async () => {
    dailyJob();
    const res = await tick({ root, now: NOW, deps: fakeDeps({ runJob: overloadRun() }) });
    const st = readState(root).jobs.a;
    expect(st.consecutiveSkips).toBe(1);
    expect(st.retryNotBefore).toBe(NOW + SKIP_BACKOFF_BASE_MS);
    expect(res[0]).toMatchObject({ id: 'a', action: 'skipped-usage-limit', reason: 'api-overload', retryAt: st.retryNotBefore });
  });

  it('the daily job is due again after the backoff, not tomorrow', async () => {
    dailyJob();
    await tick({ root, now: NOW, deps: fakeDeps({ runJob: overloadRun() }) });

    // One minute later the backoff has elapsed and the job runs for real.
    const later = NOW + SKIP_BACKOFF_BASE_MS;
    const deps = fakeDeps();
    const res = await tick({ root, now: later, deps });
    expect(res).toEqual([{ id: 'a', action: 'launched', exit: 0, timedOut: false }]);
    expect(deps.runJob).toHaveBeenCalledOnce();
  });

  it('a subscription limit with a reset time waits for that time, not for the exponent', async () => {
    dailyJob();
    // 11am is ahead of 09:05, so it resolves to today.
    await tick({ root, now: NOW, deps: fakeDeps({ runJob: limitRun('5-hour limit reached ∙ resets 11am') }) });
    const st = readState(root).jobs.a;
    expect(st.lastSkipReason).toBe('usage-limit');
    expect(st.lastSkipResetAt).toContain('11am');
    expect(st.retryNotBefore).toBe(new Date(2026, 7, 4, 11, 0).getTime());
  });
});

describe('the retry gate', () => {
  it('holds a due job back until retryNotBefore, writing and logging nothing', async () => {
    dailyJob();
    writeJobState(root, 'a', {
      lastRun: YESTERDAY_SLOT, lastExit: 1, pid: null, consecutiveFailures: 0,
      lastSkipReason: 'api-overload', lastSkipAt: NOW, consecutiveSkips: 1, retryNotBefore: NOW + 5 * MIN,
    });
    const deps = fakeDeps();
    const before = readState(root).jobs.a;

    const res = await tick({ root, now: NOW + MIN, deps });

    expect(res).toEqual([{ id: 'a', action: 'skipped-retry-wait', reason: 'api-overload', retryAt: NOW + 5 * MIN }]);
    expect(deps.runJob).not.toHaveBeenCalled();
    expect(deps.appendLog).not.toHaveBeenCalled();       // log-noise policy: state only
    expect(readState(root).jobs.a).toEqual(before);      // nothing written at all
  });

  it('lets the job through the moment the backoff has elapsed', async () => {
    dailyJob();
    writeJobState(root, 'a', {
      lastRun: YESTERDAY_SLOT, lastExit: 1, pid: null, consecutiveFailures: 0,
      lastSkipReason: 'api-overload', lastSkipAt: NOW, consecutiveSkips: 1, retryNotBefore: NOW + 5 * MIN,
    });
    const deps = fakeDeps();
    const res = await tick({ root, now: NOW + 5 * MIN, deps });
    expect(res).toEqual([{ id: 'a', action: 'launched', exit: 0, timedOut: false }]);
  });

  it('a minutely job under an overload backs off instead of spinning every 60 s', async () => {
    minutelyJob();
    const deps = fakeDeps({ runJob: overloadRun() });
    let now = NOW;

    // 20 minutes of ticking, one tick per minute.
    for (let i = 0; i < 20; i++, now += MIN) await tick({ root, now, deps });

    // Without the gate this would be 20 launches. With it: minute 0, +1, +3, +7, +15.
    expect(deps.runJob.mock.calls.length).toBe(5);
    expect(readState(root).jobs.a.consecutiveSkips).toBe(5);
    expect(readState(root).jobs.a.lastRun).toBe(NOW - MIN); // still untouched
  });

  it('a minutely job with a known reset time does not relaunch before it', async () => {
    minutelyJob();
    const deps = fakeDeps({ runJob: limitRun('usage limit reached ∙ resets 11am') });
    let now = NOW;
    for (let i = 0; i < 60; i++, now += MIN) await tick({ root, now, deps });
    // One launch at 09:05; the reset is 11:00, so the next hour of ticks stays quiet.
    expect(deps.runJob).toHaveBeenCalledOnce();
    expect(readState(root).jobs.a.retryNotBefore).toBe(new Date(2026, 7, 4, 11, 0).getTime());
  });
});

describe('a pending retry outlives the catch-up window', () => {
  // isDue clamps its catch-up window to 24 h, so without the override a sparse job
  // skipped on quota would lose its slot anyway once the outage passed a day — the same
  // defect as the brief's, one order of magnitude worse on a weekly schedule.
  it('keeps a weekly job due through an outage longer than a day', async () => {
    const lastMonday = new Date(2026, 7, 3, 6, 0).getTime(); // 2026-08-03 is a Monday
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '0 6 * * 1', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'a', { lastRun: lastMonday, lastExit: 0, pid: null, consecutiveFailures: 0 });

    // Monday 06:00 + a week: due, and the API is overloaded.
    const dueAt = new Date(2026, 7, 10, 6, 0).getTime();
    await tick({ root, now: dueAt, deps: fakeDeps({ runJob: overloadRun() }) });
    expect(readState(root).jobs.a.lastRun).toBe(lastMonday);

    // Three days later the outage clears. The natural catch-up window is long gone.
    const deps = fakeDeps();
    const res = await tick({ root, now: dueAt + 3 * 24 * HOUR, deps });
    expect(res).toEqual([{ id: 'a', action: 'launched', exit: 0, timedOut: false }]);
  });

  it('runs exactly once when a long outage clears, not once per missed slot', async () => {
    dailyJob();
    const skipping = fakeDeps({ runJob: overloadRun() });
    let now = NOW;
    // Three days of minute ticks would be 4320 iterations; step by the cap instead, which
    // is the only cadence the gate lets through once the backoff has saturated.
    for (let i = 0; i < 40; i++, now += SKIP_BACKOFF_MAX_MS) await tick({ root, now, deps: skipping });
    expect(readState(root).jobs.a.lastRun).toBe(YESTERDAY_SLOT);

    const healthy = fakeDeps();
    await tick({ root, now, deps: healthy });
    expect(healthy.runJob).toHaveBeenCalledOnce();

    // And it does not immediately run again for every slot it missed.
    const after = fakeDeps();
    await tick({ root, now: now + MIN, deps: after });
    expect(after.runJob).not.toHaveBeenCalled();
  });
});

describe('clearing the retry state', () => {
  it('a real run clears it and puts the schedule back to normal', async () => {
    dailyJob();
    await tick({ root, now: NOW, deps: fakeDeps({ runJob: overloadRun() }) });
    await tick({ root, now: NOW + SKIP_BACKOFF_BASE_MS, deps: fakeDeps() });

    const st = readState(root).jobs.a;
    expect(st.lastRun).toBe(NOW + SKIP_BACKOFF_BASE_MS);
    expect(st.retryNotBefore).toBeUndefined();
    expect(st.consecutiveSkips).toBeUndefined();
    expect(st.lastSkipReason).toBeUndefined();
  });

  it('a failing run clears it too — the slot was consumed by a real launch', async () => {
    dailyJob();
    await tick({ root, now: NOW, deps: fakeDeps({ runJob: overloadRun() }) });
    const failing = vi.fn(async () => ({ pid: 1, exit: 3, timedOut: false, durationMs: 5, out: 'boom', err: '' }));
    await tick({ root, now: NOW + SKIP_BACKOFF_BASE_MS, deps: fakeDeps({ runJob: failing }) });

    const st = readState(root).jobs.a;
    expect(st.retryNotBefore).toBeUndefined();
    expect(st.consecutiveSkips).toBeUndefined();
    expect(st.consecutiveFailures).toBe(1);
  });

  it('a quiet guard clears the retry but keeps the skip history', async () => {
    writeJobs(root, {
      version: 1, defaults: {},
      jobs: [{ id: 'a', schedule: '20 6 * * *', enabled: true, prompt: 'go', guard: 'true' }],
    });
    writeJobState(root, 'a', {
      lastRun: YESTERDAY_SLOT, lastExit: 1, pid: null, consecutiveFailures: 0,
      lastSkipReason: 'api-overload', lastSkipAt: NOW, consecutiveSkips: 2, retryNotBefore: NOW,
    });
    const runGuard = vi.fn(async () => ({ outcome: 'quiet', exit: 75, out: 'nothing to do', err: '', durationMs: 1 }));
    const res = await tick({ root, now: NOW, deps: fakeDeps({ runGuard }) });

    expect(res).toEqual([{ id: 'a', action: 'guard-quiet' }]);
    const st = readState(root).jobs.a;
    expect(st.lastRun).toBe(NOW);                  // a quiet guard DOES consume the slot
    expect(st.retryNotBefore).toBeUndefined();     // so there is nothing left to retry
    expect(st.consecutiveSkips).toBeUndefined();
    expect(st.lastSkipReason).toBe('api-overload'); // but the history stays true
  });
});

describe('invariants that must not regress', () => {
  it('the breaker never moves, no matter how many skips in a row', async () => {
    dailyJob(); // maxConsecutiveFailures: 2
    const deps = fakeDeps({ runJob: overloadRun() });
    let now = NOW;
    for (let i = 0; i < 10; i++, now += SKIP_BACKOFF_MAX_MS) await tick({ root, now, deps });

    const st = readState(root).jobs.a;
    expect(st.consecutiveSkips).toBe(10);
    expect(st.consecutiveFailures).toBe(0);
    expect(st.breakerTripped).toBeUndefined();
  });

  it('a state file written before this feature behaves exactly as it did', async () => {
    // No retryNotBefore, no consecutiveSkips, and lastRun already advanced by the old
    // code — i.e. the job genuinely is waiting for its next scheduled slot.
    dailyJob();
    writeJobState(root, 'a', {
      lastRun: NOW, lastExit: 1, pid: null, consecutiveFailures: 0,
      lastSkipReason: 'api-overload', lastSkipAt: NOW,
    });
    const deps = fakeDeps();
    const res = await tick({ root, now: NOW + MIN, deps });
    expect(res).toEqual([{ id: 'a', action: 'not-due' }]);
    expect(deps.runJob).not.toHaveBeenCalled();
  });
});
