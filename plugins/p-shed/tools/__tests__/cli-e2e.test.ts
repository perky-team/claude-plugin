import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-shed/tools/pshed.mjs');

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-e2e-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const runCli = (args: string[]) =>
  execFileSync('node', [CLI, ...args, '--json'], {
    encoding: 'utf-8',
    cwd: root,
  });

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitForDead = async (pid: number, ms: number) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('cli e2e', () => {
  it('set-job then rm-job persists to jobs.yml', () => {
    const added = JSON.parse(runCli(['set-job', '--schedule', '*/15 * * * *', '--prompt', 'Do it']));
    expect(added.created).toBe(true);
    expect(existsSync(join(root, '.pshed', 'jobs.yml'))).toBe(true);
    const removed = JSON.parse(runCli(['rm-job', '--id', added.id]));
    expect(removed.removed).toBe(true);
  });

  it('set-job with a bad cron exits 2', () => {
    expect(() => runCli(['set-job', '--schedule', 'nope', '--prompt', 'x'])).toThrow(/Command failed/);
  });

  it('set-job --effort persists the level to jobs.yml', () => {
    runCli(['set-job', '--id', 'strategist', '--schedule', '* * * * *', '--prompt', 'go', '--effort', 'high']);
    const yml = readFileSync(join(root, '.pshed', 'jobs.yml'), 'utf-8');
    expect(yml).toMatch(/effort: high/);
  });

  it('set-job with an invalid effort exits 2 with a validation error', () => {
    let err: any;
    try {
      runCli(['set-job', '--id', 'x', '--schedule', '* * * * *', '--prompt', 'go', '--effort', 'bogus']);
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.status).toBe(2);
    expect(JSON.parse(err.stdout).error.code).toBe('validation');
  });

  it('reset-breaker clears a tripped job state and pause marker', () => {
    runCli(['set-job', '--id', 'a', '--schedule', '* * * * *', '--prompt', 'go']);
    const stateFile = join(root, '.pshed', 'state', 'a.json');
    mkdirSync(join(root, '.pshed', 'state'), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ lastRun: 1, consecutiveFailures: 3, breakerTripped: true, breakerReason: 'exit 1' }));
    mkdirSync(join(root, '.pshed', 'run'), { recursive: true });
    writeFileSync(join(root, '.pshed', 'run', 'a.pause'), 'stuck');

    const res = JSON.parse(runCli(['reset-breaker', 'a']));
    expect(res.cleared).toBe(true);
    const st = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(st.breakerTripped).toBeUndefined();
    expect(st.consecutiveFailures).toBe(0);
    expect(existsSync(join(root, '.pshed', 'run', 'a.pause'))).toBe(false);
  });

  it('pause writes run/PAUSED, tick short-circuits, resume restores', () => {
    runCli(['set-job', '--id', 'a', '--schedule', '* * * * *', '--prompt', 'go']);

    const paused = JSON.parse(runCli(['pause', '--reason', 'reconfiguring']));
    expect(paused.paused).toBe(true);
    expect(existsSync(join(root, '.pshed', 'run', 'PAUSED'))).toBe(true);

    const t = JSON.parse(runCli(['tick']));
    expect(t).toMatchObject({ action: 'tick', paused: true, launched: 0 });

    const resumed = JSON.parse(runCli(['resume']));
    expect(resumed.paused).toBe(false);
    expect(existsSync(join(root, '.pshed', 'run', 'PAUSED'))).toBe(false);

    // After resume the scheduler evaluates jobs again: a brand-new job baselines.
    const t2 = JSON.parse(runCli(['tick']));
    expect(t2.results).toEqual([{ id: 'a', action: 'baselined' }]);
  });

  it('remove-cron from a folder with no installed entry reports removed:false + a warning (wrong-dir incident)', () => {
    const out = JSON.parse(runCli(['remove-cron']));
    expect(out.removed).toBe(false);
    expect(out.warning).toMatch(/nothing removed/);
    expect(Array.isArray(out.installedTaskIds)).toBe(true);
  }, 15000); // shells out to the OS scheduler; allow headroom under parallel-suite load

  it('status reports installed:false, global paused, and per-job breaker/pause/lastRun', () => {
    runCli(['set-job', '--id', 'a', '--schedule', '* * * * *', '--prompt', 'go']);
    mkdirSync(join(root, '.pshed', 'state'), { recursive: true });
    writeFileSync(join(root, '.pshed', 'state', 'a.json'),
      JSON.stringify({ lastRun: 4000, lastExit: 1, pid: null, consecutiveFailures: 3, breakerTripped: true, breakerReason: 'exit 1' }));
    mkdirSync(join(root, '.pshed', 'run'), { recursive: true });
    writeFileSync(join(root, '.pshed', 'run', 'a.pause'), 'verify red');
    runCli(['pause', '--reason', 'reconfiguring']);

    const s = JSON.parse(runCli(['status']));
    expect(s.action).toBe('status');
    expect(s.installed).toBe(false);
    expect(s.paused).toBe(true);
    expect(s.pauseReason).toBe('reconfiguring');
    const a = s.jobs.find((j: any) => j.id === 'a');
    expect(a).toMatchObject({ breakerTripped: true, breakerReason: 'exit 1', paused: true, lastExit: 1, consecutiveFailures: 3 });
  });

  it('status --human prints a text table', () => {
    runCli(['set-job', '--id', 'a', '--schedule', '* * * * *', '--prompt', 'go']);
    const text = execFileSync('node', [CLI, 'status', '--human'], { encoding: 'utf-8', cwd: root });
    expect(text).toMatch(/installed:/);
    expect(text).toContain('lastExit');
    expect(text).toContain('a');
  });

  it('stop --kill tears down and terminates an in-flight job', async () => {
    // A sacrificial long-lived process standing in for a running job's child.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100000)'], {
      detached: process.platform !== 'win32', stdio: 'ignore',
    });
    child.unref();
    const pid = child.pid as number;
    mkdirSync(join(root, '.pshed', 'run'), { recursive: true });
    writeFileSync(join(root, '.pshed', 'run', 'a.pid'), String(pid));
    try {
      const out = JSON.parse(runCli(['stop', '--kill', '--grace-ms', '100']));
      expect(out.action).toBe('stop');
      expect(out.killed.terminated).toBe(1);
      expect(out.killed.ids).toContain('a');
      await waitForDead(pid, 3000);
      expect(isAlive(pid)).toBe(false);
    } finally {
      try { process.kill(pid); } catch { /* already gone */ }
    }
  }, 15000); // stop also shells out to the OS scheduler; headroom under parallel-suite load

  it('run <id> launches the configured claude binary immediately', () => {
    // A fake "claude" that records it was called into a sentinel file.
    const sentinel = join(root, 'called.txt');
    const fake = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude.sh');
    if (process.platform === 'win32') {
      writeFileSync(fake, `@echo done> "${sentinel}"\r\n`);
    } else {
      writeFileSync(fake, `#!/bin/sh\necho done > "${sentinel}"\n`);
      chmodSync(fake, 0o755);
    }
    runCli(['set-job', '--id', 'a', '--schedule', '* * * * *', '--prompt', 'go']);
    // Point config.json at the fake claude.
    writeFileSync(join(root, '.pshed', 'config.json'), JSON.stringify({ nodeBin: 'node', claudeBin: fake }));
    const res = JSON.parse(runCli(['run', 'a']));
    expect(res.result.pid).toBeGreaterThan(0);
    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, 'utf-8')).toContain('done');
  });
});
