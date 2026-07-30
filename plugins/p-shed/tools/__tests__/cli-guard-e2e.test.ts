import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-shed/tools/pshed.mjs');

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-guarde2e-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const runCli = (args: string[]) =>
  execFileSync('node', [CLI, ...args, '--json'], { encoding: 'utf-8', cwd: root });

// A fake "claude" that records it was called into a sentinel file.
const sentinel = () => join(root, 'called.txt');
const wireFakeClaude = () => {
  const fake = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude.sh');
  if (process.platform === 'win32') {
    writeFileSync(fake, `@echo done> "${sentinel()}"\r\n`);
  } else {
    writeFileSync(fake, `#!/bin/sh\necho done > "${sentinel()}"\n`);
    chmodSync(fake, 0o755);
  }
  writeFileSync(join(root, '.pshed', 'config.json'), JSON.stringify({ nodeBin: 'node', claudeBin: fake }));
};
const seedDue = (id: string) => {
  mkdirSync(join(root, '.pshed', 'state'), { recursive: true });
  writeFileSync(join(root, '.pshed', 'state', `${id}.json`),
    JSON.stringify({ lastRun: Date.now() - 3_600_000, lastExit: 0, pid: null, consecutiveFailures: 0 }));
};
const readJobState = (id: string) => JSON.parse(readFileSync(join(root, '.pshed', 'state', `${id}.json`), 'utf-8'));
const GUARD_QUIET = 'node -e "process.exit(75)"';
const GUARD_PASS = 'node -e "process.exit(0)"';
const GUARD_CRASH = 'node -e "process.exit(1)"';

describe('cli guard e2e', () => {
  it('set-job persists guard flags; --guard "" clears both', () => {
    runCli(['set-job', '--id', 'a', '--schedule', '* * * * *', '--prompt', 'go', '--guard', GUARD_QUIET, '--guard-timeout-sec', '120']);
    let yml = readFileSync(join(root, '.pshed', 'jobs.yml'), 'utf-8');
    expect(yml).toContain('guard:');
    expect(yml).toContain('guardTimeoutSec: 120');
    runCli(['set-job', '--id', 'a', '--guard', '']);
    yml = readFileSync(join(root, '.pshed', 'jobs.yml'), 'utf-8');
    expect(yml).not.toContain('guard:');
    expect(yml).not.toContain('guardTimeoutSec');
  });

  it('tick: quiet guard consumes the slot, no launch, lastGuard recorded (e2e)', () => {
    runCli(['set-job', '--id', 'a', '--schedule', '* * * * *', '--prompt', 'go', '--guard', GUARD_QUIET]);
    wireFakeClaude();
    seedDue('a');
    const t = JSON.parse(runCli(['tick']));
    expect(t.results).toEqual([{ id: 'a', action: 'guard-quiet' }]);
    expect(existsSync(sentinel())).toBe(false);
    const st = readJobState('a');
    expect(st.lastGuard.outcome).toBe('quiet');
    expect(st.consecutiveGuardFailures).toBe(0);
  }, 15000);

  it('tick: exit-0 guard launches; history log record carries guarded: true (e2e)', () => {
    runCli(['set-job', '--id', 'a', '--schedule', '* * * * *', '--prompt', 'go', '--guard', GUARD_PASS]);
    wireFakeClaude();
    seedDue('a');
    const t = JSON.parse(runCli(['tick']));
    expect(t.results[0]).toMatchObject({ id: 'a', action: 'launched' });
    expect(existsSync(sentinel())).toBe(true);
    const day = new Date().toISOString().slice(0, 10);
    const log = readFileSync(join(root, '.pshed', 'logs', `${day}.jsonl`), 'utf-8');
    expect(log).toContain('"guarded":true');
  }, 15000);

  it('tick: crashing guard -> guard-error, breaker trips at threshold, next tick skips (fail-closed e2e)', () => {
    runCli(['set-job', '--id', 'a', '--schedule', '* * * * *', '--prompt', 'go', '--guard', GUARD_CRASH, '--max-consecutive-failures', '1']);
    wireFakeClaude();
    seedDue('a');
    const t = JSON.parse(runCli(['tick']));
    expect(t.results[0]).toMatchObject({ id: 'a', action: 'guard-error', exit: 1 });
    expect(existsSync(sentinel())).toBe(false);
    const st = readJobState('a');
    expect(st.breakerTripped).toBe(true);
    expect(st.breakerReason).toBe('guard exit 1');
    const t2 = JSON.parse(runCli(['tick']));
    expect(t2.results[0].action).toBe('skipped-breaker');
  }, 15000);

  it('run <id> respects a quiet guard (no launch, stateless); --no-guard bypasses', () => {
    runCli(['set-job', '--id', 'a', '--schedule', '* * * * *', '--prompt', 'go', '--guard', GUARD_QUIET]);
    wireFakeClaude();
    const quiet = JSON.parse(runCli(['run', 'a']));
    expect(quiet).toMatchObject({ id: 'a', outcome: 'guard-quiet' });
    expect(existsSync(sentinel())).toBe(false);
    expect(existsSync(join(root, '.pshed', 'state', 'a.json'))).toBe(false); // stateless (A5)

    const bypass = JSON.parse(runCli(['run', 'a', '--no-guard']));
    expect(bypass.outcome).toBe('success');
    expect(existsSync(sentinel())).toBe(true);
  }, 15000);
});
