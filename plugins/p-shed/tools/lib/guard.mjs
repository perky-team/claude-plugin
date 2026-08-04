import { spawn } from 'node:child_process';
import { killTree } from './launch.mjs';

// "Deliberately quiet — no work this slot." EX_TEMPFAIL in sysexits.h. A value no
// crashing tool emits by accident (crashes exit 1/2, not-found 127, non-exec 126,
// SIGKILL 137), so a broken guard always surfaces as an error instead of reading
// as eternal quiet — the classic fail-open reader defect.
export const GUARD_QUIET_EXIT = 75;

// Cap for the reason kept in state. The full stdout is capped at 64 KB below, and
// state/<id>.json is rewritten on EVERY tick — keeping the whole tail there would make
// a per-minute JSON write unboundedly large for the sake of one status column.
export const GUARD_REASON_MAX = 120;

// The guard's own one-line explanation of its decision, distilled from stdout.
//
// LAST non-empty line, not the first: `guard: a && b` is the supported way to compose
// conditions and a shell chain prints in order, so the last line comes from the link
// that actually decided. Whitespace is collapsed because the value lands in a
// tab-separated status row, where a stray newline would render as a fake job row.
// Returns '' — never null — so callers can spread it in conditionally and simply omit
// the field rather than storing an empty string.
export function guardReason(out) {
  if (typeof out !== 'string' || out.length === 0) return '';
  const lines = out.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/\s+/g, ' ').trim();
    if (!line) continue;
    return line.length > GUARD_REASON_MAX ? `${line.slice(0, GUARD_REASON_MAX - 3)}...` : line;
  }
  return '';
}

// Execute a job's guard command and classify the result:
//   exit 0  -> 'pass'  (launch the job)
//   exit 75 -> 'quiet' (skip silently — not a failure)
//   else / timeout / spawn error -> 'error' (counts toward the breaker)
// Mirrors runJob: async spawn, bounded tail capture, timeout timer -> killTree.
// shell: true — the guard is an arbitrary shell line from jobs.yml (owner-authored,
// same trust level as the prompt); cwd resolves exactly like the run itself.
export function runGuard({ job, defaults = {}, root, spawnFn = spawn, killFn = killTree, now = Date.now }) {
  return new Promise((resolve) => {
    const start = now();
    const timeoutSec = job.guardTimeoutSec ?? 30;
    const child = spawnFn(job.guard, [], {
      cwd: job.cwd ?? defaults.cwd ?? root,
      shell: true,
      env: { ...process.env, PSHED_JOB_ID: job.id, PSHED_ROOT: root },
      detached: process.platform !== 'win32', // own process group so killTree(-pid) reaps children on POSIX
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const CAP = 64 * 1024;
    let out = '', err = '';
    child.stdout?.on('data', (c) => { out = (out + c).slice(-CAP); });
    child.stderr?.on('data', (c) => { err = (err + c).slice(-CAP); });
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    let timedOut = false;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const outcome = r.exit === 0 ? 'pass' : r.exit === GUARD_QUIET_EXIT ? 'quiet' : 'error';
      resolve({ ...r, outcome });
    };
    const timer = setTimeout(() => { timedOut = true; killFn(child.pid); }, timeoutSec * 1000);
    child.on('exit', (code) => finish({ exit: timedOut ? null : code, timedOut, durationMs: now() - start, out, err }));
    child.on('error', (e) => finish({ exit: null, timedOut, error: e?.message ?? String(e), durationMs: now() - start, out, err }));
  });
}
