import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from '../lib/tick.mjs';
import { writeJobs, writeJobState, readState, paths } from '../lib/io.mjs';
import { writePid } from '../lib/pids.mjs';
import { pausePath } from '../lib/breaker.mjs';
import { readGlobalPause, writeGlobalPause } from '../lib/pause.mjs';
import { writeDeployOwner } from '../lib/owner.mjs';

const MIN = 60000;

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-tick-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const NOW = new Date(2026, 6, 16, 1, 20).getTime(); // 2026-07-16 01:20 local

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

describe('tick', () => {
  it('baselines a brand-new job instead of launching it', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    const deps = fakeDeps();
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual([{ id: 'a', action: 'baselined' }]);
    expect(deps.runJob).not.toHaveBeenCalled();
    expect(readState(root).jobs.a.lastRun).toBe(NOW);
  });

  it('launches a due job and persists state + log', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '*/15 * * * *', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'a', { lastRun: new Date(2026, 6, 16, 1, 5).getTime(), lastExit: 0, pid: null });
    const deps = fakeDeps();
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual([{ id: 'a', action: 'launched', exit: 0, timedOut: false }]);
    expect(deps.runJob).toHaveBeenCalledOnce();
    expect(deps.appendLog).toHaveBeenCalledOnce();
    expect(readState(root).jobs.a.lastRun).toBe(NOW);
    expect(readState(root).jobs.a.lastExit).toBe(0);
  });

  it('skips a job whose previous run is still alive', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '*/15 * * * *', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'a', { lastRun: new Date(2026, 6, 16, 1, 5).getTime(), lastExit: null, pid: 777 });
    const deps = fakeDeps({ isPidAlive: vi.fn(() => true) });
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual([{ id: 'a', action: 'skipped' }]);
    expect(deps.runJob).not.toHaveBeenCalled();
  });

  it('reports not-due for an enabled job with no matching minute', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '*/15 * * * *', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'a', { lastRun: new Date(2026, 6, 16, 1, 16).getTime(), lastExit: 0, pid: null });
    const deps = fakeDeps();
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual([{ id: 'a', action: 'not-due' }]);
  });

  it('rotates logs once per tick', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [] });
    const deps = fakeDeps();
    await tick({ root, now: NOW, deps });
    expect(deps.rotateLogs).toHaveBeenCalledOnce();
  });

  it('rotates logs with the default 7-day retention when defaults sets none', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [] });
    const deps = fakeDeps();
    await tick({ root, now: NOW, deps });
    expect(deps.rotateLogs).toHaveBeenCalledWith(root, NOW, 7);
  });

  it('passes a configured defaults.logRetentionDays through to rotateLogs', async () => {
    writeJobs(root, { version: 1, defaults: { logRetentionDays: 30 }, jobs: [] });
    const deps = fakeDeps();
    await tick({ root, now: NOW, deps });
    expect(deps.rotateLogs).toHaveBeenCalledWith(root, NOW, 30);
  });

  it('passes 0 through unchanged (keep every log)', async () => {
    writeJobs(root, { version: 1, defaults: { logRetentionDays: 0 }, jobs: [] });
    const deps = fakeDeps();
    await tick({ root, now: NOW, deps });
    expect(deps.rotateLogs).toHaveBeenCalledWith(root, NOW, 0);
  });

  it('falls back to 7 instead of throwing when defaults.logRetentionDays is invalid', async () => {
    writeJobs(root, { version: 1, defaults: { logRetentionDays: -5 }, jobs: [] });
    const deps = fakeDeps();
    const res = await tick({ root, now: NOW, deps }); // must not throw — the tick keeps ticking
    expect(Array.isArray(res)).toBe(true);
    expect(deps.rotateLogs).toHaveBeenCalledWith(root, NOW, 7);
  });

  it('writes the pidfile at spawn (onSpawn) and removes it after a launch', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '*/15 * * * *', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'a', { lastRun: new Date(2026, 6, 16, 1, 5).getTime(), lastExit: 0, pid: null });
    const deps = fakeDeps({
      runJob: vi.fn(async ({ onSpawn }) => { onSpawn?.(999); return { pid: 999, exit: 0, timedOut: false, durationMs: 5 }; }),
    });
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual([{ id: 'a', action: 'launched', exit: 0, timedOut: false }]);
    expect(deps.writePid).toHaveBeenCalledWith('a', 999);
    expect(deps.removePid).toHaveBeenCalledWith('a');
  });

  it('prunes state entries for jobs no longer in jobs.yml', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '*/15 * * * *', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'ghost', { lastRun: 1, lastExit: 0, pid: null });
    writeJobState(root, 'a', { lastRun: new Date(2026, 6, 16, 1, 5).getTime(), lastExit: 0, pid: null });
    const deps = fakeDeps();
    await tick({ root, now: NOW, deps });
    expect(readState(root).jobs.ghost).toBeUndefined();
    expect(readState(root).jobs.a).toBeDefined();
  });

  it('trips the breaker after maxConsecutiveFailures unhealthy runs, then skips subsequent ticks', async () => {
    writeJobs(root, { version: 1, defaults: { maxConsecutiveFailures: 2 }, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null });
    const runJob = vi.fn(async () => ({ pid: 1, exit: 1, timedOut: false, durationMs: 5 }));
    const deps = fakeDeps({ runJob });

    const r1 = await tick({ root, now: NOW, deps });
    expect(r1).toEqual([{ id: 'a', action: 'launched', exit: 1, timedOut: false }]);
    expect(readState(root).jobs.a.consecutiveFailures).toBe(1);

    const r2 = await tick({ root, now: NOW + MIN, deps });
    expect(r2).toEqual([{ id: 'a', action: 'launched', exit: 1, timedOut: false }]);
    expect(readState(root).jobs.a.breakerTripped).toBe(true);
    expect(readState(root).jobs.a.consecutiveFailures).toBe(2);

    const r3 = await tick({ root, now: NOW + 2 * MIN, deps });
    expect(r3).toEqual([{ id: 'a', action: 'skipped-breaker', reason: 'exit 1' }]);
    expect(runJob).toHaveBeenCalledTimes(2); // not launched on the tripped tick
  });

  it('treats a timeout as unhealthy and can trip the breaker', async () => {
    writeJobs(root, { version: 1, defaults: { maxConsecutiveFailures: 1 }, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null });
    const deps = fakeDeps({ runJob: vi.fn(async () => ({ pid: 1, exit: null, timedOut: true, durationMs: 5 })) });
    await tick({ root, now: NOW, deps });
    expect(readState(root).jobs.a.breakerTripped).toBe(true);
    expect(readState(root).jobs.a.breakerReason).toBe('timeout');
  });

  it('a healthy run resets the failure counter', async () => {
    writeJobs(root, { version: 1, defaults: { maxConsecutiveFailures: 3 }, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 1, pid: null, consecutiveFailures: 2 });
    const deps = fakeDeps({ runJob: vi.fn(async () => ({ pid: 1, exit: 0, timedOut: false, durationMs: 5 })) });
    await tick({ root, now: NOW, deps });
    expect(readState(root).jobs.a.consecutiveFailures).toBe(0);
  });

  it('maxConsecutiveFailures <= 0 disables the breaker', async () => {
    writeJobs(root, { version: 1, defaults: { maxConsecutiveFailures: 0 }, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 1, pid: null, consecutiveFailures: 9 });
    const deps = fakeDeps({ runJob: vi.fn(async () => ({ pid: 1, exit: 1, timedOut: false, durationMs: 5 })) });
    await tick({ root, now: NOW, deps });
    expect(readState(root).jobs.a.breakerTripped).toBeUndefined();
  });

  it('short-circuits the whole tick when the global PAUSED marker is present', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null });
    writeGlobalPause(root, { reason: 'reconfiguring', now: NOW });
    const deps = fakeDeps();
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual({ action: 'tick', paused: true, launched: 0 });
    expect(deps.runJob).not.toHaveBeenCalled();
    expect(deps.rotateLogs).not.toHaveBeenCalled(); // first gate — nothing else runs
  });

  it('skips a job whose pause marker is present, without launching', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null });
    mkdirSync(paths(root).runDir, { recursive: true });
    writeFileSync(pausePath(root, 'a'), 'verify went red', 'utf-8');
    const deps = fakeDeps();
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual([{ id: 'a', action: 'skipped-paused', reason: 'verify went red' }]);
    expect(deps.runJob).not.toHaveBeenCalled();
  });

  it('merges state on launch, preserving unrelated fields and the running failure count (clobber regression)', async () => {
    writeJobs(root, { version: 1, defaults: { maxConsecutiveFailures: 5 }, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 1, pid: null, consecutiveFailures: 2, note: 'keep-me' });
    const deps = fakeDeps({ runJob: vi.fn(async () => ({ pid: 1, exit: 1, timedOut: false, durationMs: 5 })) });
    await tick({ root, now: NOW, deps });
    const st = readState(root).jobs.a;
    expect(st.consecutiveFailures).toBe(3); // incremented from prior state, not wiped
    expect(st.note).toBe('keep-me');        // unrelated field survives the write
    expect(st.lastExit).toBe(1);
  });

  it('skips a disabled job silently', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [
      { id: 'off', schedule: '* * * * *', enabled: false, prompt: 'x' },
      { id: 'on', schedule: '*/15 * * * *', enabled: true, prompt: 'go' },
    ] });
    writeJobState(root, 'on', { lastRun: new Date(2026, 6, 16, 1, 5).getTime(), lastExit: 0, pid: null });
    const deps = fakeDeps();
    const res = await tick({ root, now: NOW, deps });
    expect(res.find((r) => r.id === 'off')).toBeUndefined();
    expect(res).toEqual([{ id: 'on', action: 'launched', exit: 0, timedOut: false }]);
  });

  // A usage-limit / transient-overload run is quota/infra, not a code failure: the
  // breaker must not move and the run must be a skip, so the next tick retries when
  // the window resets. See classify.mjs.
  const usageLimitJob = () => {
    writeJobs(root, { version: 1, defaults: { maxConsecutiveFailures: 2 }, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null, consecutiveFailures: 1 });
  };

  it('skips a usage-limit run (text) without touching the breaker counter', async () => {
    usageLimitJob();
    const runJob = vi.fn(async () => ({ pid: 1, exit: 1, timedOut: false, durationMs: 5, out: 'Claude usage limit reached', err: '' }));
    const res = await tick({ root, now: NOW, deps: fakeDeps({ runJob }) });
    // retryAt: the skip no longer consumes the slot, so the tick reports when the job may
    // try again (lib/backoff.mjs). See tick-skip-retry.test.ts for that behaviour.
    expect(res).toEqual([{ id: 'a', action: 'skipped-usage-limit', reason: 'usage-limit', retryAt: NOW + MIN }]);
    const st = readState(root).jobs.a;
    expect(st.consecutiveFailures).toBe(1);        // NOT incremented, NOT reset
    expect(st.breakerTripped).toBeUndefined();     // NOT tripped
    expect(st.lastSkipReason).toBe('usage-limit'); // visible to status
  });

  it('records a reset time from the limit message when present', async () => {
    usageLimitJob();
    const runJob = vi.fn(async () => ({ pid: 1, exit: 1, timedOut: false, durationMs: 5, out: '5-hour limit reached ∙ resets 3am', err: '' }));
    const res = await tick({ root, now: NOW, deps: fakeDeps({ runJob }) });
    expect(res[0]).toMatchObject({ id: 'a', action: 'skipped-usage-limit', reason: 'usage-limit' });
    expect(String(res[0].resetAt)).toContain('3am');
    expect(readState(root).jobs.a.lastSkipResetAt).toContain('3am');
  });

  it('skips a usage-limit run detected via structured JSON (is_error + 429)', async () => {
    usageLimitJob();
    const out = JSON.stringify({ type: 'result', is_error: true, api_error_status: 429, result: 'overloaded' });
    const runJob = vi.fn(async () => ({ pid: 1, exit: 1, timedOut: false, durationMs: 5, out, err: '' }));
    await tick({ root, now: NOW, deps: fakeDeps({ runJob }) });
    const st = readState(root).jobs.a;
    expect(st.consecutiveFailures).toBe(1);
    expect(st.breakerTripped).toBeUndefined();
    expect(st.lastSkipReason).toBe('api-overload'); // a 429 is infra, not the subscription
  });

  it('skips a transient API overload (529 overloaded_error)', async () => {
    usageLimitJob();
    const runJob = vi.fn(async () => ({ pid: 1, exit: 1, timedOut: false, durationMs: 5, out: '', err: 'API Error: 529 overloaded_error' }));
    const res = await tick({ root, now: NOW, deps: fakeDeps({ runJob }) });
    expect(res).toEqual([{ id: 'a', action: 'skipped-usage-limit', reason: 'api-overload', retryAt: NOW + MIN }]);
    expect(readState(root).jobs.a.consecutiveFailures).toBe(1);
  });

  // Reporting only: an overload skip and a subscription skip schedule identically, but
  // the log/state must not claim quota was burned when the API was merely overloaded.
  it('logs an overload skip as reason api-overload, a subscription limit as usage-limit', async () => {
    usageLimitJob();
    const overload = fakeDeps({ runJob: vi.fn(async () => ({ pid: 1, exit: 1, timedOut: false, durationMs: 5, out: '', err: 'API Error: 529 overloaded_error' })) });
    await tick({ root, now: NOW, deps: overload });
    expect(overload.appendLog.mock.calls[0][1]).toMatchObject({ outcome: 'skipped', reason: 'api-overload' });

    const limit = fakeDeps({ runJob: vi.fn(async () => ({ pid: 1, exit: 1, timedOut: false, durationMs: 5, out: 'Claude usage limit reached', err: '' })) });
    await tick({ root, now: NOW + MIN, deps: limit });
    expect(limit.appendLog.mock.calls[0][1]).toMatchObject({ outcome: 'skipped', reason: 'usage-limit' });
    expect(readState(root).jobs.a.lastSkipReason).toBe('usage-limit');
  });

  // A non-retryable API error will fail identically forever. Treating it as a limit
  // made the job skip on every tick while the breaker stayed clean — invisible to any
  // watchdog keyed on breakerTripped.
  it('counts a non-retryable API error (401) as a failure and lets the breaker trip', async () => {
    usageLimitJob(); // maxConsecutiveFailures: 2, consecutiveFailures starts at 1
    const out = JSON.stringify({ type: 'result', is_error: true, api_error_status: 401, result: 'Invalid API key' });
    const runJob = vi.fn(async () => ({ pid: 1, exit: 1, timedOut: false, durationMs: 5, out, err: '' }));
    const res = await tick({ root, now: NOW, deps: fakeDeps({ runJob }) });
    expect(res).toEqual([{ id: 'a', action: 'launched', exit: 1, timedOut: false }]);
    const st = readState(root).jobs.a;
    expect(st.consecutiveFailures).toBe(2);
    expect(st.breakerTripped).toBe(true);
    expect(st.lastSkipReason).toBeUndefined(); // not a skip at all
  });

  it('a usage-limit skip never trips the breaker no matter how many in a row', async () => {
    usageLimitJob(); // maxConsecutiveFailures: 2, starts at 1
    const runJob = vi.fn(async () => ({ pid: 1, exit: 1, timedOut: false, durationMs: 5, out: 'usage limit reached', err: '' }));
    const deps = fakeDeps({ runJob });
    await tick({ root, now: NOW, deps });
    await tick({ root, now: NOW + MIN, deps });
    await tick({ root, now: NOW + 2 * MIN, deps });
    const st = readState(root).jobs.a;
    expect(st.consecutiveFailures).toBe(1);
    expect(st.breakerTripped).toBeUndefined();
  });

  it('a genuine crash (non-zero, no limit signature) still counts as a failure', async () => {
    usageLimitJob(); // consecutiveFailures starts at 1
    const runJob = vi.fn(async () => ({ pid: 1, exit: 1, timedOut: false, durationMs: 5, out: 'panic: runtime error: index out of range', err: '' }));
    const res = await tick({ root, now: NOW, deps: fakeDeps({ runJob }) });
    expect(res).toEqual([{ id: 'a', action: 'launched', exit: 1, timedOut: false }]);
    expect(readState(root).jobs.a.consecutiveFailures).toBe(2); // incremented, exactly as before
    expect(readState(root).jobs.a.breakerTripped).toBe(true);   // reached maxConsecutiveFailures: 2
  });

  // What a run COST. Successful runs are the expensive ones, and their result JSON was
  // parsed for classification and then dropped — leaving wall-clock duration, which is
  // meaningless across jobs on different models, as the only cost proxy.
  describe('usage/cost capture in the run log', () => {
    const dueJob = () => {
      writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
      writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null });
    };
    const resultJson = (extra: Record<string, unknown> = {}) => JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      duration_ms: 120000, duration_api_ms: 98765, num_turns: 12, total_cost_usd: 0.42,
      usage: { input_tokens: 1234, output_tokens: 5678, cache_read_input_tokens: 90123, cache_creation_input_tokens: 4567 },
      modelUsage: { 'claude-opus-4-5-20260101': { inputTokens: 1234, outputTokens: 5678, costUSD: 0.42 } },
      result: 'done', ...extra,
    });
    const loggedRow = (deps: any) => deps.appendLog.mock.calls[0][1];

    it('records the usage block on a SUCCESSFUL run, additively to the existing fields', async () => {
      dueJob();
      const deps = fakeDeps({ runJob: vi.fn(async () => ({ pid: 1, exit: 0, timedOut: false, durationMs: 7, out: resultJson(), err: '' })) });
      await tick({ root, now: NOW, deps });
      const row = loggedRow(deps);
      expect(row).toMatchObject({ ts: NOW, job: 'a', exit: 0, timedOut: false, durationMs: 7, outcome: 'success' });
      expect(row.usage).toEqual({
        costUsd: 0.42, in: 1234, out: 5678, cacheRead: 90123, cacheCreate: 4567, turns: 12, apiMs: 98765,
        models: { 'claude-opus-4-5-20260101': { in: 1234, out: 5678, costUsd: 0.42 } },
      });
      expect(row.raw).toBeUndefined(); // success still keeps no raw tail
    });

    it('logs a row with NO usage field when a successful run printed non-JSON output', async () => {
      dueJob();
      const deps = fakeDeps({ runJob: vi.fn(async () => ({ pid: 1, exit: 0, timedOut: false, durationMs: 7, out: 'all done, nothing to do', err: '' })) });
      await tick({ root, now: NOW, deps });
      const row = loggedRow(deps);
      expect(row).toMatchObject({ job: 'a', outcome: 'success' });
      expect('usage' in row).toBe(false);
    });

    it('records token counts and omits costUsd when total_cost_usd is missing', async () => {
      dueJob();
      const noCost = JSON.parse(resultJson());
      delete noCost.total_cost_usd;
      const deps = fakeDeps({ runJob: vi.fn(async () => ({ pid: 1, exit: 0, timedOut: false, durationMs: 7, out: JSON.stringify(noCost), err: '' })) });
      await tick({ root, now: NOW, deps });
      const row = loggedRow(deps);
      expect(row.usage).toMatchObject({ in: 1234, out: 5678, turns: 12 });
      expect('costUsd' in row.usage).toBe(false);
    });

    it('a timeout-killed run (exit null, truncated output) logs its row and does not throw', async () => {
      dueJob();
      const truncated = '{"type":"result","subtype":"success","usage":{"input_to';
      const deps = fakeDeps({ runJob: vi.fn(async () => ({ pid: 1, exit: null, timedOut: true, durationMs: 900000, out: truncated, err: '' })) });
      await expect(tick({ root, now: NOW, deps })).resolves.toBeDefined();
      const row = loggedRow(deps);
      expect(row).toMatchObject({ job: 'a', exit: null, timedOut: true, outcome: 'failure' });
      expect('usage' in row).toBe(false);
      expect(readState(root).jobs.a.consecutiveFailures).toBe(1); // breaker path unchanged
    });

    it('records usage on a usage-limit skip too when the result JSON carries it', async () => {
      dueJob();
      const out = resultJson({ is_error: true, subtype: 'error_during_execution', api_error_status: 529, result: 'API Error: 529 overloaded_error' });
      const deps = fakeDeps({ runJob: vi.fn(async () => ({ pid: 1, exit: 1, timedOut: false, durationMs: 7, out, err: '' })) });
      await tick({ root, now: NOW, deps });
      const row = loggedRow(deps);
      expect(row).toMatchObject({ outcome: 'skipped', reason: 'api-overload' });
      expect(row.usage).toMatchObject({ costUsd: 0.42, in: 1234 });
    });
  });

  // Cross-job coordination: jobs sharing a working directory must not run at once, and
  // the answer is "not now, next tick" — never a wait. A lock would charge the queued
  // time to the run's own timeoutSec; catch-up starts the skipped job as soon as the
  // group frees.
  describe('concurrency groups', () => {
    // 'a' is live (pidfile -> pid 111, which the fake liveness probe calls alive);
    // 'b' is due. Both are in jobs.yml, 'a' first.
    const grouped = (aGroup?: string | null, bGroup?: string | null, defaults: Record<string, unknown> = {}) => {
      const withGroup = (id: string, g?: string | null) => ({
        id, schedule: '* * * * *', enabled: true, prompt: 'go',
        ...(g === undefined ? {} : { concurrencyGroup: g }),
      });
      writeJobs(root, { version: 1, defaults: { maxConsecutiveFailures: 3, ...defaults }, jobs: [withGroup('a', aGroup), withGroup('b', bGroup)] });
      writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null });
      writeJobState(root, 'b', { lastRun: NOW - MIN, lastExit: 0, pid: null, consecutiveFailures: 2, note: 'keep-me' });
      writePid(root, 'a', 111);
    };
    const liveDeps = (overrides = {}) => fakeDeps({ isPidAlive: vi.fn((pid: number) => pid === 111), ...overrides });
    const resultFor = (res: any[], id: string) => res.find((r) => r.id === id);

    it('skips a due job whose group is held by a live groupmate, naming the holder', async () => {
      grouped('tree', 'tree');
      const deps = liveDeps();
      const res = await tick({ root, now: NOW, deps });
      expect(resultFor(res, 'b')).toEqual({ id: 'b', action: 'skipped-group', group: 'tree', holder: 'a' });
      expect(deps.runJob).not.toHaveBeenCalled();
    });

    it('leaves the skipped job\'s state completely untouched (no slot consumed)', async () => {
      grouped('tree', 'tree');
      await tick({ root, now: NOW, deps: liveDeps() });
      expect(readState(root).jobs.b).toEqual({
        lastRun: NOW - MIN, lastExit: 0, pid: null, consecutiveFailures: 2, note: 'keep-me',
      });
    });

    it('launches a due job whose group is free (different group)', async () => {
      grouped('tree', 'chat');
      const deps = liveDeps();
      const res = await tick({ root, now: NOW, deps });
      expect(resultFor(res, 'b')).toMatchObject({ id: 'b', action: 'launched' });
      expect(deps.runJob).toHaveBeenCalledOnce();
    });

    it('launches both when no group is configured anywhere (backward compatible)', async () => {
      grouped(undefined, undefined);
      const deps = liveDeps();
      const res = await tick({ root, now: NOW, deps });
      expect(resultFor(res, 'b')).toMatchObject({ id: 'b', action: 'launched' });
    });

    it('inherits defaults.concurrencyGroup for a job with no explicit field', async () => {
      grouped(undefined, undefined, { concurrencyGroup: 'tree' });
      const res = await tick({ root, now: NOW, deps: liveDeps() });
      expect(resultFor(res, 'b')).toMatchObject({ action: 'skipped-group', group: 'tree', holder: 'a' });
    });

    it('a per-job group overrides the default', async () => {
      grouped(undefined, 'chat', { concurrencyGroup: 'tree' });
      const res = await tick({ root, now: NOW, deps: liveDeps() });
      expect(resultFor(res, 'b')).toMatchObject({ action: 'launched' });
    });

    it('an explicit clear beats the default — the job stays unconstrained', async () => {
      grouped(undefined, null, { concurrencyGroup: 'tree' });
      const res = await tick({ root, now: NOW, deps: liveDeps() });
      expect(resultFor(res, 'b')).toMatchObject({ action: 'launched' });
    });

    it('a stale pidfile pointing at a dead pid does not hold the group', async () => {
      grouped('tree', 'tree');
      const deps = fakeDeps({ isPidAlive: vi.fn(() => false) }); // same probe the duplicate guard uses
      const res = await tick({ root, now: NOW, deps });
      expect(resultFor(res, 'b')).toMatchObject({ action: 'launched' });
    });

    // Two different diagnoses: 'skipped' = this job is still running, 'skipped-group' =
    // a groupmate is. A log reader must not have to conflate them.
    it('distinguishes the same-job skip from the groupmate skip', async () => {
      grouped('tree', 'tree');
      const res = await tick({ root, now: NOW, deps: liveDeps() });
      expect(res).toEqual([
        { id: 'a', action: 'skipped' },
        { id: 'b', action: 'skipped-group', group: 'tree', holder: 'a' },
      ]);
    });

    // The group gate stops a job from STARTING while a groupmate is live. Within one
    // tick the loop is sequential (deliberately — see CLAUDE.md), so groupmates due in
    // the same minute run back-to-back and are never live at the same time.
    it('does not skip a groupmate when nothing is actually live', async () => {
      grouped('tree', 'tree');
      const deps = fakeDeps({ isPidAlive: vi.fn(() => false) });
      const res = await tick({ root, now: NOW, deps });
      expect(res.map((r: any) => r.action)).toEqual(['launched', 'launched']);
      expect(deps.runJob).toHaveBeenCalledTimes(2);
    });

    it('does not evaluate the group before the schedule (a not-due groupmate stays not-due)', async () => {
      grouped('tree', 'tree');
      writeJobs(root, { version: 1, defaults: {}, jobs: [
        { id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go', concurrencyGroup: 'tree' },
        { id: 'b', schedule: '*/15 * * * *', enabled: true, prompt: 'go', concurrencyGroup: 'tree' },
      ] });
      writeJobState(root, 'b', { lastRun: new Date(2026, 6, 16, 1, 16).getTime(), lastExit: 0, pid: null });
      const res = await tick({ root, now: NOW, deps: liveDeps() });
      expect(resultFor(res, 'b')).toEqual({ id: 'b', action: 'not-due' });
    });
  });

  it('clears a stale usage-limit skip marker once the job runs for real again', async () => {
    writeJobs(root, { version: 1, defaults: { maxConsecutiveFailures: 3 }, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 1, pid: null, consecutiveFailures: 0, lastSkipReason: 'usage-limit', lastSkipAt: NOW - MIN });
    const runJob = vi.fn(async () => ({ pid: 1, exit: 0, timedOut: false, durationMs: 5, out: 'ok', err: '' }));
    await tick({ root, now: NOW, deps: fakeDeps({ runJob }) });
    expect(readState(root).jobs.a.lastSkipReason).toBeUndefined();
    expect(readState(root).jobs.a.consecutiveFailures).toBe(0);
  });

  describe('orphaned deploy pause reclaim', () => {
    it('runs BEFORE the global-pause gate, so an abandoned deploy pause does not wedge the tick', async () => {
      // The gate short-circuits on any marker regardless of origin, so a reclaim placed
      // after it would never run.
      writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'w', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
      writeGlobalPause(root, { reason: 'prompt update', origin: 'deploy', now: NOW });
      writeDeployOwner(root, { pid: 999001, scope: 'global', now: NOW });

      const res = await tick({ root, now: NOW, deps: fakeDeps({ isPidAlive: vi.fn(() => false) }) });

      expect(Array.isArray(res)).toBe(true);
      expect((res as any[])[0]).toEqual({ action: 'reclaimed-deploy-pause', reclaimed: [{ scope: 'global' }] });
      expect(readGlobalPause(root)).toBeNull();
    });

    it('leaves a live deploy alone — the tick stays short-circuited', async () => {
      writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'w', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
      writeGlobalPause(root, { reason: 'prompt update', origin: 'deploy', now: NOW });
      writeDeployOwner(root, { pid: process.pid, scope: 'global', now: NOW });

      const res = await tick({ root, now: NOW, deps: fakeDeps({ isPidAlive: vi.fn((pid: number) => pid === process.pid) }) });

      expect(res).toEqual({ action: 'tick', paused: true, launched: 0 });
      expect(readGlobalPause(root)).not.toBeNull();
    });

    it('leaves an operator pause alone and stays short-circuited', async () => {
      writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'w', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
      writeGlobalPause(root, { reason: 'halted by hand', now: NOW });
      writeDeployOwner(root, { pid: 999001, scope: 'global', now: NOW });

      const res = await tick({ root, now: NOW, deps: fakeDeps({ isPidAlive: vi.fn(() => false) }) });

      expect(res).toEqual({ action: 'tick', paused: true, launched: 0 });
      expect(readGlobalPause(root)).not.toBeNull();
    });

    // I3: the README's run-log contract promises `ts`/`job`/`durationMs` always and
    // `outcome` only ever one of success|failure|skipped|guard-error. The reclaim row
    // used to violate both (`{ ts, outcome: 'reclaimed-deploy-pause', reclaimed }` — no
    // `job` field at all, and an `outcome` value outside the documented enum), which would
    // make `lib/report.mjs`'s `aggregate` misread the row as a real run instead of an
    // event (it branches on `action` present with no `outcome`). The fix logs a distinct
    // `action` and an explicit `job: null`, honest about not being a run record.
    it('logs the reclaim as a distinct action with an explicit job:null, not an outcome', async () => {
      writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'w', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
      writeGlobalPause(root, { reason: 'prompt update', origin: 'deploy', now: NOW });
      writeDeployOwner(root, { pid: 999001, scope: 'global', now: NOW });

      const deps = fakeDeps({ isPidAlive: vi.fn(() => false) });
      await tick({ root, now: NOW, deps });

      expect(deps.appendLog).toHaveBeenCalledOnce();
      const row = deps.appendLog.mock.calls[0][1];
      expect(row).toEqual({ ts: NOW, job: null, action: 'reclaimed-deploy-pause', reclaimed: [{ scope: 'global' }] });
      expect(row.outcome).toBeUndefined();
    });
  });
});
