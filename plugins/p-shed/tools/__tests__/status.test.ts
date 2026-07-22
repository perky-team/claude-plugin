import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectStatus, formatHuman } from '../lib/status.mjs';
import { writeJobs, writeJobState, paths } from '../lib/io.mjs';
import { pausePath } from '../lib/breaker.mjs';
import { writeGlobalPause } from '../lib/pause.mjs';
import { writePid } from '../lib/pids.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-status-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('collectStatus', () => {
  it('reports installed + global pause and per-job running/paused/breaker/lastRun', () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [
      { id: 'runner', schedule: '* * * * *', enabled: true, prompt: 'go' },
      { id: 'tripped', schedule: '* * * * *', enabled: true, prompt: 'go' },
      { id: 'selfpaused', schedule: '* * * * *', enabled: true, prompt: 'go' },
    ] });
    writeJobState(root, 'runner', { lastRun: 5000, lastExit: 0, pid: 111, consecutiveFailures: 0 });
    writeJobState(root, 'tripped', { lastRun: 4000, lastExit: 1, pid: null, consecutiveFailures: 3, breakerTripped: true, breakerReason: 'exit 1' });
    mkdirSync(paths(root).runDir, { recursive: true });
    writeFileSync(pausePath(root, 'selfpaused'), 'verify red', 'utf-8');
    writePid(root, 'runner', 111);
    writeGlobalPause(root, { reason: 'reconfiguring', now: 1 });

    const status = collectStatus(root, { installed: true, deps: { isPidAlive: (pid: number) => pid === 111 } });
    expect(status.action).toBe('status');
    expect(status.installed).toBe(true);
    expect(status.paused).toBe(true);
    expect(status.pauseReason).toBe('reconfiguring');

    const byId = Object.fromEntries(status.jobs.map((j: any) => [j.id, j]));
    expect(byId.runner).toMatchObject({ running: true, pid: 111, paused: false, breakerTripped: false, lastRun: 5000, lastExit: 0 });
    expect(byId.tripped).toMatchObject({ running: false, breakerTripped: true, breakerReason: 'exit 1', consecutiveFailures: 3 });
    expect(byId.selfpaused).toMatchObject({ paused: true, pauseReason: 'verify red' });
  });

  it('defaults installed to null when not probed, and running:false with no pidfile', () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    const status = collectStatus(root);
    expect(status.installed).toBeNull();
    expect(status.paused).toBe(false);
    expect(status.jobs[0]).toMatchObject({ id: 'a', running: false, paused: false, breakerTripped: false, consecutiveFailures: 0, lastRun: null });
  });
});

describe('formatHuman', () => {
  it('renders the task, install/pause state, and one row per job', () => {
    const status = {
      action: 'status', task: 'pshed-abc', installed: false, paused: true, pauseReason: 'x',
      jobs: [{ id: 'a', enabled: true, running: true, pid: 1, paused: false, breakerTripped: false, consecutiveFailures: 0, lastRun: 1, lastExit: 0 }],
    };
    const text = formatHuman(status);
    expect(text).toContain('pshed-abc');
    expect(text).toMatch(/installed:\s*false/);
    expect(text).toMatch(/paused:\s*true/);
    expect(text).toContain('a');
  });
});
