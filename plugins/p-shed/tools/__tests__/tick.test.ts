import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from '../lib/tick.mjs';
import { writeJobs, writeState, readState } from '../lib/io.mjs';

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
    writeState(root, { jobs: { a: { lastRun: new Date(2026, 6, 16, 1, 5).getTime(), lastExit: 0, pid: null } } });
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
    writeState(root, { jobs: { a: { lastRun: new Date(2026, 6, 16, 1, 5).getTime(), lastExit: null, pid: 777 } } });
    const deps = fakeDeps({ isPidAlive: vi.fn(() => true) });
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual([{ id: 'a', action: 'skipped' }]);
    expect(deps.runJob).not.toHaveBeenCalled();
  });

  it('reports not-due for an enabled job with no matching minute', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '*/15 * * * *', enabled: true, prompt: 'go' }] });
    writeState(root, { jobs: { a: { lastRun: new Date(2026, 6, 16, 1, 16).getTime(), lastExit: 0, pid: null } } });
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
});
