import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
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
