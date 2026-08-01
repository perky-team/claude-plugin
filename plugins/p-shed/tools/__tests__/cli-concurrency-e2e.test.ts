import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-shed/tools/pshed.mjs');

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-conce2e-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const runCli = (args: string[]) =>
  execFileSync('node', [CLI, ...args, '--json'], { encoding: 'utf-8', cwd: root });

const pidFile = (id: string) => join(root, '.pshed', 'run', `${id}.pid`);
const sentinel = () => join(root, 'called.txt');

// A fake "claude" that copies the RUNNING job's pidfile into a sentinel, proving the
// duplicate/group guard could see it for the whole run.
//
// The trailing `exit 0` is load-bearing: without it the script's status is the COPY's
// status, so a missing or not-yet-written pidfile makes `cat` exit 1 and the run reads
// as a genuine `failure`. Measured on Linux, where four tests in this file failed for
// that reason alone — the scheduler was classifying the stub correctly and the stub was
// lying. Windows hid it because `type` under `@echo off` leaves the batch status at 0.
const wireFakeClaude = (id: string) => {
  const fake = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude.sh');
  if (process.platform === 'win32') {
    writeFileSync(fake, `@echo off\r\ntype "${pidFile(id)}" > "${sentinel()}" 2>nul\r\nexit /b 0\r\n`);
  } else {
    // Wait briefly for the pidfile to appear before copying it. The pid only exists
    // once the child is spawned, so `onSpawn` necessarily writes the file a moment
    // AFTER the stub starts running — on Linux the stub routinely won this race and
    // copied nothing, which the test then read as "the guard could not see the run".
    writeFileSync(
      fake,
      `#!/bin/sh\ni=0\nwhile [ ! -s "${pidFile(id)}" ] && [ $i -lt 40 ]; do i=$((i+1)); sleep 0.05; done\ncat "${pidFile(id)}" > "${sentinel()}" 2>/dev/null\nexit 0\n`,
    );
    chmodSync(fake, 0o755);
  }
  writeFileSync(join(root, '.pshed', 'config.json'), JSON.stringify({ nodeBin: 'node', claudeBin: fake }));
};

// A pidfile pointing at THIS test process — guaranteed alive, no spawning needed.
const holdWith = (id: string, pid = process.pid) => {
  mkdirSync(join(root, '.pshed', 'run'), { recursive: true });
  writeFileSync(pidFile(id), String(pid), 'utf-8');
};

describe('cli concurrency e2e', () => {
  it('set-job persists concurrencyGroup; --concurrency-group "" writes an explicit null', () => {
    runCli(['set-job', '--id', 'a', '--schedule', '* * * * *', '--prompt', 'go', '--concurrency-group', 'tree']);
    let yml = readFileSync(join(root, '.pshed', 'jobs.yml'), 'utf-8');
    expect(yml).toContain('concurrencyGroup: tree');
    runCli(['set-job', '--id', 'a', '--concurrency-group', '']);
    yml = readFileSync(join(root, '.pshed', 'jobs.yml'), 'utf-8');
    expect(yml).toMatch(/concurrencyGroup: (null|~)/);
  }, 15000);

  // `run` used to write NO pidfile, so a manual run was invisible to the scheduled
  // tick and could double-launch in the same working directory.
  it('run writes the job pidfile for the duration of the run and clears it after', () => {
    runCli(['set-job', '--id', 'a', '--schedule', '* * * * *', '--prompt', 'go']);
    wireFakeClaude('a');
    const res = JSON.parse(runCli(['run', 'a']));
    expect(res.outcome).toBe('success');
    expect(existsSync(sentinel())).toBe(true);
    expect(Number(readFileSync(sentinel(), 'utf-8').trim())).toBe(res.result.pid); // live during the run
    expect(existsSync(pidFile('a'))).toBe(false);                                   // cleared after
  }, 15000);

  it('run refuses while the same job is already live', () => {
    runCli(['set-job', '--id', 'a', '--schedule', '* * * * *', '--prompt', 'go']);
    wireFakeClaude('a');
    holdWith('a');
    const res = JSON.parse(runCli(['run', 'a']));
    expect(res).toMatchObject({ id: 'a', outcome: 'skipped', reason: 'already-running', pid: process.pid });
    expect(existsSync(sentinel())).toBe(false);
  }, 15000);

  it('run refuses while a groupmate holds the group, naming the holder', () => {
    runCli(['set-job', '--id', 'worker', '--schedule', '* * * * *', '--prompt', 'go', '--concurrency-group', 'tree']);
    runCli(['set-job', '--id', 'chat', '--schedule', '* * * * *', '--prompt', 'go', '--concurrency-group', 'tree']);
    wireFakeClaude('chat');
    holdWith('worker');
    const res = JSON.parse(runCli(['run', 'chat']));
    expect(res).toMatchObject({ id: 'chat', outcome: 'skipped-group', group: 'tree', holder: 'worker' });
    expect(existsSync(sentinel())).toBe(false);
  }, 15000);

  it('run in a different group is unaffected by the holder', () => {
    runCli(['set-job', '--id', 'worker', '--schedule', '* * * * *', '--prompt', 'go', '--concurrency-group', 'tree']);
    runCli(['set-job', '--id', 'chat', '--schedule', '* * * * *', '--prompt', 'go', '--concurrency-group', 'chat']);
    wireFakeClaude('chat');
    holdWith('worker');
    expect(JSON.parse(runCli(['run', 'chat'])).outcome).toBe('success');
    expect(existsSync(sentinel())).toBe(true);
  }, 15000);

  it('run --force proceeds while the group is held and leaves the holder pidfile intact', () => {
    runCli(['set-job', '--id', 'worker', '--schedule', '* * * * *', '--prompt', 'go', '--concurrency-group', 'tree']);
    runCli(['set-job', '--id', 'chat', '--schedule', '* * * * *', '--prompt', 'go', '--concurrency-group', 'tree']);
    wireFakeClaude('chat');
    holdWith('worker');
    expect(JSON.parse(runCli(['run', 'chat', '--force'])).outcome).toBe('success');
    expect(existsSync(sentinel())).toBe(true);
    expect(readFileSync(pidFile('worker'), 'utf-8').trim()).toBe(String(process.pid)); // holder untouched
  }, 15000);

  // The group must be derived from the per-job pidfiles: a run/<group>.pid would show
  // up in listPidEntries() and invent a phantom job for both status and stop.
  it('status and stop see no phantom group entry after a grouped run', () => {
    runCli(['set-job', '--id', 'worker', '--schedule', '* * * * *', '--prompt', 'go', '--concurrency-group', 'tree']);
    wireFakeClaude('worker');
    expect(JSON.parse(runCli(['run', 'worker'])).outcome).toBe('success');

    const status = JSON.parse(runCli(['status']));
    expect(status.jobs.map((j: { id: string }) => j.id)).toEqual(['worker']);
    const stopped = JSON.parse(runCli(['stop', '--kill', '--grace-ms', '0']));
    expect(stopped.killed).toEqual({ terminated: 0, ids: [] });
  }, 20000);
});
