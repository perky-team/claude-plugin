import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectStatus, formatHuman } from '../lib/status.mjs';
import { writeJobs, writeJobState, paths } from '../lib/io.mjs';
import { pausePath, writePause } from '../lib/breaker.mjs';
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

  it("surfaces a job's last usage-limit skip so a stuck-on-limit job is visible", () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'a', { lastRun: 5000, lastExit: 1, pid: null, consecutiveFailures: 1, lastSkipReason: 'usage-limit', lastSkipResetAt: '3am' });
    const status = collectStatus(root);
    const a = status.jobs.find((j: any) => j.id === 'a');
    expect(a).toMatchObject({ lastSkipReason: 'usage-limit', lastSkipResetAt: '3am' });
    expect(formatHuman(status)).toContain('usage-limit');
  });

  // I2: `status` used to read only `gp.reason` / a job's reason, so a live `deploy`
  // holding the loop open was INDISTINGUISHABLE from an operator pause someone forgot to
  // `resume` — exactly the confusion `origin` exists to remove (resetBreaker already
  // makes this distinction, reporting `deployPause: true`).
  it('surfaces pauseOrigin for both the global marker and a per-job pause', () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [
      { id: 'worker', schedule: '* * * * *', enabled: true, prompt: 'go' },
    ] });
    writeGlobalPause(root, { reason: 'deploying prompt update', origin: 'deploy', now: 1 });
    writePause(root, 'worker', { reason: 'deploying prompt update', origin: 'deploy' });

    const status = collectStatus(root);
    expect(status.pauseOrigin).toBe('deploy');
    const worker = status.jobs.find((j: any) => j.id === 'worker');
    expect(worker).toMatchObject({ paused: true, pauseOrigin: 'deploy' });
  });

  it('leaves pauseOrigin undefined for a plain operator/self pause (additive, not a new required field)', () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [
      { id: 'selfpaused', schedule: '* * * * *', enabled: true, prompt: 'go' },
    ] });
    mkdirSync(paths(root).runDir, { recursive: true });
    writeFileSync(pausePath(root, 'selfpaused'), 'verify red', 'utf-8'); // no header -> self
    const status = collectStatus(root);
    expect(status.pauseOrigin).toBeUndefined(); // no global marker at all
    const j = status.jobs.find((x: any) => x.id === 'selfpaused');
    expect(j).toMatchObject({ pauseOrigin: 'self' });
  });

  // `writeGlobalPause` only ever writes an explicit `origin` field for a deploy pause — a
  // plain `pshed pause --reason ...` writes none (see lib/pause.mjs) — so a present marker
  // with no `origin` key can only be an ordinary operator pause. Before this fix, that case
  // reported `pauseOrigin: undefined`, which a JSON consumer cannot tell apart from "marker
  // present but truly unknown"; per-job status never has this ambiguity, since a written
  // header always says which non-self origin it is.
  it('reports pauseOrigin "operator" for a global marker with no explicit origin field', () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [] });
    writeGlobalPause(root, { reason: 'reconfiguring', now: 1 }); // no origin arg -> operator
    const status = collectStatus(root);
    expect(status.paused).toBe(true);
    expect(status.pauseOrigin).toBe('operator');
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

  // I2: the origin must be visible in the human table too, not just the JSON — status
  // --human is the surface the README points an operator at.
  it('shows a non-operator pause origin on the global line and in a per-job column', () => {
    const status: any = {
      action: 'status', task: 'pshed-abc', installed: false,
      paused: true, pauseReason: 'deploying prompt update', pauseOrigin: 'deploy',
      jobs: [{
        id: 'worker', enabled: true, running: false, paused: true,
        pauseReason: 'deploying prompt update', pauseOrigin: 'deploy',
        breakerTripped: false, consecutiveFailures: 0, lastRun: 1, lastExit: 0,
      }],
    };
    const text = formatHuman(status);
    expect(text).toMatch(/paused:\s*true \(deploying prompt update\) \[deploy\]/);
    const jobLine = text.split('\n').find((l) => l.startsWith('worker\t'));
    expect(jobLine).toBeDefined();
    expect(jobLine).toContain('deploy');
  });

  it('does not annotate an ordinary operator pause with a redundant [operator] tag', () => {
    const status: any = {
      action: 'status', task: 'pshed-abc', installed: false,
      paused: true, pauseReason: 'by hand', pauseOrigin: 'operator',
      jobs: [],
    };
    expect(formatHuman(status)).not.toContain('[operator]');
  });
});

// `lastSkip: api-overload` reads as "it was skipped", not as "it will not run again for
// 23 hours" — and the second is the one an operator acts on. Since a quota skip no longer
// consumes the slot, those really are two different states and status has to name them.
describe('a pending retry is distinguishable from waiting for the next slot', () => {
  const NOW = new Date(2026, 7, 4, 9, 5).getTime();

  function skipped(extra: Record<string, unknown>) {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '20 6 * * *', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'a', {
      lastRun: NOW - 60_000, lastExit: 1, pid: null, consecutiveFailures: 0,
      lastSkipReason: 'api-overload', lastSkipAt: NOW, ...extra,
    });
    return collectStatus(root);
  }

  it('carries retryNotBefore and consecutiveSkips into the JSON', () => {
    const status = skipped({ retryNotBefore: NOW + 7 * 60_000, consecutiveSkips: 3 });
    expect(status.jobs[0]).toMatchObject({ retryNotBefore: NOW + 7 * 60_000, consecutiveSkips: 3 });
  });

  it('names the moment a retry is still pending', () => {
    const status = skipped({ retryNotBefore: new Date(2026, 7, 4, 9, 12).getTime(), consecutiveSkips: 3 });
    const row = formatHuman(status, NOW).split('\n').find((l) => l.startsWith('a\t'))!;
    expect(row).toContain('api-overload retry 09:12');
  });

  it('says the retry is due now once the backoff has elapsed', () => {
    const status = skipped({ retryNotBefore: NOW - 1000, consecutiveSkips: 2 });
    const row = formatHuman(status, NOW).split('\n').find((l) => l.startsWith('a\t'))!;
    expect(row).toContain('api-overload retry-now');
  });

  it('says next-slot for a skip with no retry pending — which is every pre-upgrade state file', () => {
    const status = skipped({});   // no retryNotBefore: lastRun was advanced by the old code
    const row = formatHuman(status, NOW).split('\n').find((l) => l.startsWith('a\t'))!;
    expect(row).toContain('api-overload next-slot');
    expect(row).not.toContain('retry');
  });

  it('still shows the reset time from the limit message alongside the retry', () => {
    const status = skipped({
      lastSkipReason: 'usage-limit', lastSkipResetAt: '11am',
      retryNotBefore: new Date(2026, 7, 4, 11, 0).getTime(), consecutiveSkips: 1,
    });
    const row = formatHuman(status, NOW).split('\n').find((l) => l.startsWith('a\t'))!;
    expect(row).toContain('usage-limit retry 11:00');
    expect(row).toContain('resets 11am');
  });

  it('leaves a job that never skipped alone', () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    writeJobState(root, 'a', { lastRun: NOW, lastExit: 0, pid: null, consecutiveFailures: 0 });
    const status = collectStatus(root);
    expect(status.jobs[0].retryNotBefore).toBeUndefined();
    const row = formatHuman(status, NOW).split('\n').find((l) => l.startsWith('a\t'))!;
    expect(row).toContain('\t-\t'); // the lastSkip column stays a plain dash
  });
});
