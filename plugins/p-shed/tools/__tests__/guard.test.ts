import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGuard, GUARD_QUIET_EXIT, guardReason, GUARD_REASON_MAX } from '../lib/guard.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-runguard-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const job = (guard: string, extra: Record<string, unknown> = {}) =>
  ({ id: 'j', schedule: '* * * * *', prompt: 'x', guard, ...extra });

describe('runGuard', () => {
  it('exports 75 as the quiet exit code', () => {
    expect(GUARD_QUIET_EXIT).toBe(75);
  });

  it('classifies exit 0 as pass', async () => {
    const g = await runGuard({ job: job('node -e "process.exit(0)"'), defaults: {}, root });
    expect(g).toMatchObject({ outcome: 'pass', exit: 0, timedOut: false });
  });

  it('classifies exit 75 as quiet', async () => {
    const g = await runGuard({ job: job('node -e "process.exit(75)"'), defaults: {}, root });
    expect(g).toMatchObject({ outcome: 'quiet', exit: 75 });
  });

  // Negative self-test (the fail-open lesson): a plain crash exit must surface as an
  // ERROR, never read as quiet. If someone "simplifies" the contract to 0/nonzero,
  // this test goes red.
  it('classifies exit 1 as error, NOT quiet', async () => {
    const g = await runGuard({ job: job('node -e "process.exit(1)"'), defaults: {}, root });
    expect(g.outcome).toBe('error');
    expect(g.exit).toBe(1);
  });

  it('classifies exit 2 as error', async () => {
    const g = await runGuard({ job: job('node -e "process.exit(2)"'), defaults: {}, root });
    expect(g.outcome).toBe('error');
  });

  it('captures stderr tail for diagnostics', async () => {
    const g = await runGuard({ job: job('node -e "console.error(\'boom-detail\');process.exit(3)"'), defaults: {}, root });
    expect(g.outcome).toBe('error');
    expect(g.err).toContain('boom-detail');
  });

  it('a timeout is an error (timedOut: true, exit null)', async () => {
    const g = await runGuard({
      job: job('node -e "setTimeout(()=>{},10000)"', { guardTimeoutSec: 0.4 }),
      defaults: {}, root,
    });
    expect(g).toMatchObject({ outcome: 'error', exit: null, timedOut: true });
  }, 10000);

  it('a spawn error resolves as error instead of crashing', async () => {
    // spawnFn stub that emits 'error' like a missing-cwd/bad-shell spawn would.
    const spawnFn = () => {
      const handlers: Record<string, (a?: unknown) => void> = {};
      const child: any = {
        pid: undefined,
        on: (ev: string, fn: (a?: unknown) => void) => {
          handlers[ev] = fn;
          if (ev === 'error') setImmediate(() => handlers.error(new Error('ENOENT')));
          return child;
        },
      };
      return child;
    };
    const g = await runGuard({ job: job('whatever'), defaults: {}, root, spawnFn: spawnFn as never });
    expect(g.outcome).toBe('error');
    expect(g.error).toContain('ENOENT');
  });

  it('exposes PSHED_JOB_ID and PSHED_ROOT to the command', async () => {
    const g = await runGuard({
      job: job('node -e "process.exit(process.env.PSHED_JOB_ID === \'j\' && process.env.PSHED_ROOT ? 0 : 1)"'),
      defaults: {}, root,
    });
    expect(g.outcome).toBe('pass');
  });

  it('runs in job.cwd ?? defaults.cwd ?? root (review resolution A3)', async () => {
    // The guard drops a marker file into its cwd; assert where it landed.
    const marker = 'node -e "require(\'fs\').writeFileSync(\'guard-was-here.txt\',\'x\')"';
    await runGuard({ job: job(marker), defaults: {}, root });
    expect(existsSync(join(root, 'guard-was-here.txt'))).toBe(true);

    const sub = mkdtempSync(join(tmpdir(), 'pshed-runguard-sub-'));
    try {
      await runGuard({ job: job(marker), defaults: { cwd: sub }, root });
      expect(existsSync(join(sub, 'guard-was-here.txt'))).toBe(true);
    } finally { rmSync(sub, { recursive: true, force: true }); }
  });
});

describe('guardReason', () => {
  it('takes the last non-empty line — the link of an `a && b` chain that decided', () => {
    expect(guardReason('checking chat\nno pending questions\n')).toBe('no pending questions');
  });

  it('ignores trailing blank lines and whitespace-only lines', () => {
    expect(guardReason('decided\n\n   \n\n')).toBe('decided');
  });

  it('collapses internal whitespace so the status table stays one row per job', () => {
    expect(guardReason('no   work:\t3 open')).toBe('no work: 3 open');
  });

  it('returns empty for empty, whitespace-only, or absent stdout', () => {
    expect(guardReason('')).toBe('');
    expect(guardReason('   \n\t\n')).toBe('');
    expect(guardReason(undefined)).toBe('');
    expect(guardReason(null)).toBe('');
  });

  it('caps a long single line', () => {
    const long = guardReason('x'.repeat(5000));
    expect(long.length).toBeLessThanOrEqual(GUARD_REASON_MAX);
    expect(long.endsWith('...')).toBe(true);
  });

  it('leaves a line exactly at the cap untouched', () => {
    const exact = 'y'.repeat(GUARD_REASON_MAX);
    expect(guardReason(exact)).toBe(exact);
  });
});
