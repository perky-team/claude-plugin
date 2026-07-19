import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from '../lib/tick.mjs';
import { writeJobs, writeJobState, readState, paths } from '../lib/io.mjs';
import { pausePath } from '../lib/breaker.mjs';

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
});
