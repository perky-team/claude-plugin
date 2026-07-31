// `pause`/`resume` can target ONE job or ONE concurrency group. The regression this
// suite exists to prevent: `pshed pause --id worker` used to ignore --id entirely and
// halt the WHOLE scheduler while answering {"action":"pause","paused":true}. Every
// error path below therefore asserts that run/PAUSED stays absent.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-shed/tools/pshed.mjs');

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-pausee2e-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const runCli = (args: string[]) =>
  execFileSync('node', [CLI, ...args, '--json'], { encoding: 'utf-8', cwd: root });
const json = (args: string[]) => JSON.parse(runCli(args));
// Non-zero exits are expected on the error paths, so read status + stdout instead of throwing.
const tryCli = (args: string[]) => {
  const r = spawnSync('node', [CLI, ...args, '--json'], { encoding: 'utf-8', cwd: root });
  return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null };
};

const pshed = (...parts: string[]) => join(root, '.pshed', ...parts);
const globalMarker = () => pshed('run', 'PAUSED');
const jobMarker = (id: string) => pshed('run', `${id}.pause`);

// A claude that exits 0 immediately, so a due job really launches in the tick.
function wireFakeClaude() {
  mkdirSync(pshed(), { recursive: true });
  const fake = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude.sh');
  if (process.platform === 'win32') writeFileSync(fake, '@echo off\r\nexit /b 0\r\n');
  else writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(pshed('config.json'), JSON.stringify({ nodeBin: 'node', claudeBin: fake }));
}

// jobs.yml written directly: `set-job` has no way to write `defaults`, and the group
// tests need a job that INHERITS its group from there.
function writeJobs(yml: string) {
  mkdirSync(pshed(), { recursive: true });
  writeFileSync(pshed('jobs.yml'), yml, 'utf-8');
}

// Baseline the given jobs an hour in the past so the next tick finds them due.
function baselineOld(ids: string[]) {
  mkdirSync(pshed('state'), { recursive: true });
  for (const id of ids) {
    writeFileSync(pshed('state', `${id}.json`), JSON.stringify({ lastRun: Date.now() - 3600_000, lastExit: 0, pid: null }));
  }
}

const twoJobs = `version: 1
jobs:
  - id: worker
    schedule: "* * * * *"
    prompt: go
  - id: chat
    schedule: "* * * * *"
    prompt: go
`;

const groupedJobs = `version: 1
defaults:
  concurrencyGroup: tree
jobs:
  - id: worker
    schedule: "* * * * *"
    prompt: go
    concurrencyGroup: tree
  - id: inheritor
    schedule: "* * * * *"
    prompt: go
  - id: chat
    schedule: "* * * * *"
    prompt: go
    concurrencyGroup: chat
`;

const actions = (t: { results: { id: string; action: string }[] }) =>
  Object.fromEntries(t.results.map((r) => [r.id, r.action]));

describe('pause/resume --id', () => {
  it('pauses only that job: it is skipped on the next tick, every other job still runs', () => {
    writeJobs(twoJobs);
    wireFakeClaude();
    baselineOld(['worker', 'chat']);

    const res = json(['pause', '--id', 'worker', '--reason', 'deploying new config']);
    expect(res).toMatchObject({ action: 'pause', scope: 'job', id: 'worker', pausedIds: ['worker'], alreadyPausedIds: [] });
    expect(existsSync(jobMarker('worker'))).toBe(true);
    expect(existsSync(globalMarker())).toBe(false); // never widen the blast radius
    expect(existsSync(jobMarker('chat'))).toBe(false);

    const t = json(['tick']);
    expect(actions(t)).toEqual({ worker: 'skipped-paused', chat: 'launched' });
    expect(t.results.find((r: any) => r.id === 'worker').reason).toBe('deploying new config');
  }, 20000);

  it('resume --id clears it, and a second resume is a clean no-op', () => {
    writeJobs(twoJobs);
    json(['pause', '--id', 'worker']);

    const first = json(['resume', '--id', 'worker']);
    expect(first).toMatchObject({ action: 'resume', scope: 'job', id: 'worker', resumedIds: ['worker'], notPausedIds: [] });
    expect(existsSync(jobMarker('worker'))).toBe(false);

    const again = json(['resume', '--id', 'worker']);
    expect(again).toMatchObject({ resumedIds: [], notPausedIds: ['worker'] });
    expect(existsSync(globalMarker())).toBe(false);
  }, 20000);

  it('pausing an already-paused job is a no-op that keeps the first reason', () => {
    writeJobs(twoJobs);
    json(['pause', '--id', 'worker', '--reason', 'first reason']);
    const again = json(['pause', '--id', 'worker', '--reason', 'second reason']);
    expect(again).toMatchObject({ pausedIds: [], alreadyPausedIds: ['worker'] });
    expect(readFileSync(jobMarker('worker'), 'utf-8')).toContain('first reason');
    expect(readFileSync(jobMarker('worker'), 'utf-8')).not.toContain('second reason');
  }, 20000);
});

describe('pause/resume --group', () => {
  it('pauses exactly the members of the group, including one inheriting it from defaults', () => {
    writeJobs(groupedJobs);

    const res = json(['pause', '--group', 'tree', '--reason', 'tree maintenance']);
    expect(res).toMatchObject({ action: 'pause', scope: 'group', group: 'tree' });
    expect(res.pausedIds.sort()).toEqual(['inheritor', 'worker']);
    expect(existsSync(jobMarker('worker'))).toBe(true);
    expect(existsSync(jobMarker('inheritor'))).toBe(true);
    expect(existsSync(jobMarker('chat'))).toBe(false);   // other group untouched
    expect(existsSync(globalMarker())).toBe(false);

    const resumed = json(['resume', '--group', 'tree']);
    expect(resumed.resumedIds.sort()).toEqual(['inheritor', 'worker']);
    expect(existsSync(jobMarker('worker'))).toBe(false);
    expect(existsSync(jobMarker('inheritor'))).toBe(false);
  }, 20000);

  it('reports members that were already paused separately from the ones it paused', () => {
    writeJobs(groupedJobs);
    json(['pause', '--id', 'worker']);
    const res = json(['pause', '--group', 'tree']);
    expect(res).toMatchObject({ pausedIds: ['inheritor'], alreadyPausedIds: ['worker'] });
  }, 20000);
});

// The core regression: an unrecognised target must fail loudly. A silent fallback to
// the global marker is exactly the bug this change exists to remove.
describe('unmatched targets fail loudly and never pause globally', () => {
  const casesThatMustFail: [string, string[]][] = [
    ['unknown job id', ['pause', '--id', 'ghost']],
    ['group no job belongs to', ['pause', '--group', 'ghosts']],
    ['--id and --group together', ['pause', '--id', 'worker', '--group', 'tree']],
    ['valueless --id', ['pause', '--id']],
    ['unknown job id on resume', ['resume', '--id', 'ghost']],
    ['unmatched group on resume', ['resume', '--group', 'ghosts']],
  ];

  for (const [label, args] of casesThatMustFail) {
    it(`${label} exits non-zero and leaves run/PAUSED absent`, () => {
      writeJobs(groupedJobs);
      const { status, out } = tryCli(args);
      expect(status).not.toBe(0);
      expect(out.error.code).toBe('validation');
      expect(existsSync(globalMarker())).toBe(false);
    }, 20000);
  }

  it('a targeted pause in a repo with no jobs.yml errors instead of pausing everything', () => {
    const { status } = tryCli(['pause', '--id', 'worker']);
    expect(status).not.toBe(0);
    expect(existsSync(globalMarker())).toBe(false);
  }, 20000);
});

describe('unflagged pause/resume keep the global behavior', () => {
  it('writes and removes run/PAUSED and short-circuits the tick', () => {
    writeJobs(twoJobs);

    const paused = json(['pause', '--reason', 'reconfiguring']);
    expect(paused).toMatchObject({ action: 'pause', paused: true, alreadyPaused: false, reason: 'reconfiguring' });
    expect(existsSync(globalMarker())).toBe(true);
    expect(existsSync(jobMarker('worker'))).toBe(false); // global pause writes no per-job markers

    expect(json(['tick'])).toMatchObject({ action: 'tick', paused: true, launched: 0 });

    const resumed = json(['resume']);
    expect(resumed).toMatchObject({ action: 'resume', paused: false, wasPaused: true });
    expect(existsSync(globalMarker())).toBe(false);
  }, 20000);
});

describe('the job-written self-pause is unchanged', () => {
  it('a bare touch (empty marker) still pauses the job', () => {
    writeJobs(twoJobs);
    wireFakeClaude();
    baselineOld(['worker', 'chat']);
    mkdirSync(pshed('run'), { recursive: true });
    writeFileSync(jobMarker('worker'), ''); // exactly what `touch` leaves behind

    expect(actions(json(['tick']))).toEqual({ worker: 'skipped-paused', chat: 'launched' });
    expect(json(['status']).jobs.find((j: any) => j.id === 'worker').paused).toBe(true);
  }, 20000);

  it('a plain one-line reason still surfaces verbatim in status and in the tick', () => {
    writeJobs(twoJobs);
    wireFakeClaude();
    baselineOld(['worker', 'chat']);
    mkdirSync(pshed('run'), { recursive: true });
    writeFileSync(jobMarker('worker'), 'verify went red');

    const t = json(['tick']);
    expect(t.results.find((r: any) => r.id === 'worker')).toMatchObject({ action: 'skipped-paused', reason: 'verify went red' });

    const s = json(['status']);
    expect(s.jobs.find((j: any) => j.id === 'worker')).toMatchObject({ paused: true, pauseReason: 'verify went red' });

    const human = execFileSync('node', [CLI, 'status', '--human'], { encoding: 'utf-8', cwd: root });
    expect(human).toContain('verify went red');
  }, 20000);
});

describe('reset-breaker respects the marker origin', () => {
  it('clears a self-pause', () => {
    writeJobs(twoJobs);
    mkdirSync(pshed('run'), { recursive: true });
    writeFileSync(jobMarker('worker'), 'verify went red');

    const res = json(['reset-breaker', 'worker']);
    expect(res).toMatchObject({ cleared: true, pauseCleared: true });
    expect(existsSync(jobMarker('worker'))).toBe(false);
  }, 20000);

  it('leaves an operator pause in place and says so', () => {
    writeJobs(twoJobs);
    json(['pause', '--id', 'worker', '--reason', 'deploying new config']);

    const res = json(['reset-breaker', 'worker']);
    expect(res).toMatchObject({ cleared: true, pauseCleared: false, operatorPause: true });
    expect(existsSync(jobMarker('worker'))).toBe(true);
    // ...and the operator's own lever still lifts it.
    json(['resume', '--id', 'worker']);
    expect(existsSync(jobMarker('worker'))).toBe(false);
  }, 20000);
});
