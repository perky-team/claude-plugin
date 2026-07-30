# p-shed job guards + p-chat Telegram channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-job `guard` command to p-shed (exit 0 = launch, 75 = quiet skip, else = error → breaker) and ship a new zero-dep `p-chat` plugin — a dumb Telegram channel whose `guard` command answers scripted `/commands` itself and requests a Claude launch only when a free-text question is pending.

**Architecture:** Part A slots a guard step into `tick.mjs` after the `isDue` gate and before `runJob`, with its own failure counter (`consecutiveGuardFailures`) sharing the existing breaker. Part B is a standalone CLI (`plugins/p-chat/tools/pchat.mjs`) built from small libs (config/state/queue/split/api/exec/send/core), tested against an in-test mock Bot API server via the `apiBase` config seam.

**Tech Stack:** Node ≥ 18 (global `fetch`), zero external deps, vitest (repo-root config picks up `plugins/**/tools/__tests__/**/*.test.ts` automatically).

**Spec:** `docs/superpowers/specs/2026-07-29-pshed-guard-and-p-chat-design.md` (including §6 review resolutions — where §6 contradicts an earlier section, §6 wins).

## Global Constraints

- Node ≥ 18; zero external runtime deps in both plugins (Bot API is plain HTTPS + JSON).
- Guard quiet exit code is exactly `75`; a guard exiting 1 must NEVER be treated as quiet (fail-closed).
- Jobs without `guard` must be bit-for-bit unchanged; existing p-shed test files must not be modified (new behavior gets new test files).
- `guard-quiet` writes NO history-log line (a minutely job must not write 1440 lines/day); `guard-error` and launches do.
- Telegram message text is NEVER interpolated into a shell line — exact match (after trim) against `commands` keys or it is free text.
- Token lives ONLY in the token file — never in argv, env dumps, repo files, or logs.
- Empty/missing `allowedChatIds` is a hard exit-2 error for `guard`/`pending`/`send`, never "respond to anyone".
- All new CLI output follows the house style: JSON via `emitJson`, exit 0 ok / 1 internal / 2 validation-config (+ 75 quiet for `pchat guard`).
- No version bumps, no tags, no pushes in this plan — release is a separate explicitly-requested step (repo rule).
- Commit messages: Conventional Commits, English, no AI attribution of any kind.

---

## Part A — p-shed job guards

### Task 1: `runGuard` primitive (`lib/guard.mjs`)

**Files:**
- Create: `plugins/p-shed/tools/lib/guard.mjs`
- Test: `plugins/p-shed/tools/__tests__/guard.test.ts`

**Interfaces:**
- Consumes: `killTree` from `./launch.mjs` (existing).
- Produces: `GUARD_QUIET_EXIT = 75`; `runGuard({ job, defaults, root, spawnFn?, killFn?, now? }) -> Promise<{ outcome: 'pass'|'quiet'|'error', exit: number|null, timedOut: boolean, durationMs: number, out: string, err: string, error?: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-shed/tools/__tests__/guard.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGuard, GUARD_QUIET_EXIT } from '../lib/guard.mjs';

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

  it('classifies exit 2 and 127-style spawn garbage as error', async () => {
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
      const child: any = { pid: undefined, on: (ev: string, fn: () => void) => { handlers[ev] = fn; if (ev === 'error') setImmediate(() => handlers.error(new Error('ENOENT'))); return child; } };
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/guard.test.ts`
Expected: FAIL — `Cannot find module '../lib/guard.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
// plugins/p-shed/tools/lib/guard.mjs
import { spawn } from 'node:child_process';
import { killTree } from './launch.mjs';

// "Deliberately quiet — no work this slot." EX_TEMPFAIL in sysexits.h. A value no
// crashing tool emits by accident (crashes exit 1/2, not-found 127, non-exec 126,
// SIGKILL 137), so a broken guard always surfaces as an error instead of reading
// as eternal quiet — the classic fail-open reader defect.
export const GUARD_QUIET_EXIT = 75;

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/p-shed/tools/__tests__/guard.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/guard.mjs plugins/p-shed/tools/__tests__/guard.test.ts
git commit -m "feat(p-shed): runGuard primitive — exit 0/75/other -> pass/quiet/error"
```

---

### Task 2: Tick integration + guard counter in the breaker

**Files:**
- Modify: `plugins/p-shed/tools/lib/tick.mjs` (imports; insert guard block after the `isDue` check at line ~51; add `guarded` to launch log records)
- Modify: `plugins/p-shed/tools/lib/breaker.mjs` (`resetBreaker` clears `consecutiveGuardFailures`)
- Test: `plugins/p-shed/tools/__tests__/tick-guard.test.ts` (new file — existing `tick.test.ts` stays untouched)

**Interfaces:**
- Consumes: `runGuard` result shape from Task 1 (stubbed here via deps).
- Produces: tick `results` actions `'guard-quiet'` and `'guard-error'`; state fields `lastGuard: { at, outcome, exit }` and `consecutiveGuardFailures`; history-log record `{ outcome: 'guard-error', exit, timedOut, durationMs, raw? }`; launch records gain `guarded: true`. Deps key `runGuard(job, defaults)` (root pre-bound, like `writePid`).

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-shed/tools/__tests__/tick-guard.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from '../lib/tick.mjs';
import { writeJobs, writeJobState, readState, paths } from '../lib/io.mjs';
import { pausePath, resetBreaker } from '../lib/breaker.mjs';

const MIN = 60000;
const NOW = new Date(2026, 6, 29, 9, 0).getTime();

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-tickguard-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const guardJob = (jobExtra: Record<string, unknown> = {}, defaults: Record<string, unknown> = { maxConsecutiveFailures: 3 }) => {
  writeJobs(root, { version: 1, defaults, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go', guard: 'check', ...jobExtra }] });
};
const seed = (extra: Record<string, unknown> = {}) =>
  writeJobState(root, 'a', { lastRun: NOW - MIN, lastExit: 0, pid: null, ...extra });

const gr = (outcome: string, extra: Record<string, unknown> = {}) => ({
  outcome,
  exit: outcome === 'pass' ? 0 : outcome === 'quiet' ? 75 : 1,
  timedOut: false, durationMs: 3, out: '', err: '', ...extra,
});

function fakeDeps(overrides: Record<string, unknown> = {}) {
  return {
    runJob: vi.fn(async () => ({ pid: 123, exit: 0, timedOut: false, durationMs: 5, out: '', err: '' })),
    runGuard: vi.fn(async () => gr('pass')),
    appendLog: vi.fn(),
    rotateLogs: vi.fn(),
    isPidAlive: vi.fn(() => false),
    writePid: vi.fn(),
    removePid: vi.fn(),
    ...overrides,
  };
}

describe('tick + guard', () => {
  it('guard pass -> launched; log record has guarded: true; guard counter reset; lastGuard recorded', async () => {
    guardJob();
    seed({ consecutiveGuardFailures: 2 });
    const deps = fakeDeps();
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual([{ id: 'a', action: 'launched', exit: 0, timedOut: false }]);
    expect(deps.appendLog).toHaveBeenCalledOnce();
    expect((deps.appendLog as any).mock.calls[0][1]).toMatchObject({ outcome: 'success', guarded: true });
    const st = readState(root).jobs.a;
    expect(st.consecutiveGuardFailures).toBe(0);
    expect(st.lastGuard).toMatchObject({ at: NOW, outcome: 'pass', exit: 0 });
  });

  it('an unguarded launch log record has NO guarded flag (bit-for-bit unchanged)', async () => {
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go' }] });
    seed();
    const deps = fakeDeps();
    await tick({ root, now: NOW, deps });
    expect(deps.runGuard).not.toHaveBeenCalled();
    expect((deps.appendLog as any).mock.calls[0][1].guarded).toBeUndefined();
  });

  it('guard quiet -> silent skip: slot consumed, no launch, NO history log line, run-failure counter untouched', async () => {
    guardJob();
    seed({ consecutiveFailures: 2 });
    const deps = fakeDeps({ runGuard: vi.fn(async () => gr('quiet')) });
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual([{ id: 'a', action: 'guard-quiet' }]);
    expect(deps.runJob).not.toHaveBeenCalled();
    expect(deps.appendLog).not.toHaveBeenCalled(); // log-noise policy: quiet is state-only
    const st = readState(root).jobs.a;
    expect(st.lastRun).toBe(NOW);                  // schedule slot consumed
    expect(st.consecutiveFailures).toBe(2);        // run counter untouched
    expect(st.consecutiveGuardFailures).toBe(0);   // quiet proves the guard healthy
    expect(st.lastGuard).toMatchObject({ outcome: 'quiet', exit: 75 });
  });

  it('guard error -> skip + increment guard counter + history log line with raw tail', async () => {
    guardJob();
    seed();
    const deps = fakeDeps({ runGuard: vi.fn(async () => gr('error', { exit: 2, err: 'guard broke' })) });
    const res = await tick({ root, now: NOW, deps });
    expect(res).toEqual([{ id: 'a', action: 'guard-error', exit: 2, timedOut: false }]);
    expect(deps.runJob).not.toHaveBeenCalled();
    expect(deps.appendLog).toHaveBeenCalledOnce();
    expect((deps.appendLog as any).mock.calls[0][1]).toMatchObject({ job: 'a', outcome: 'guard-error', exit: 2, raw: 'guard broke' });
    const st = readState(root).jobs.a;
    expect(st.consecutiveGuardFailures).toBe(1);
    expect(st.lastRun).toBe(NOW);
    expect(st.breakerTripped).toBeUndefined();
  });

  it('maxConsecutiveFailures guard errors trip the breaker; later ticks skip WITHOUT invoking the guard', async () => {
    guardJob({}, { maxConsecutiveFailures: 2 });
    seed();
    const runGuard = vi.fn(async () => gr('error'));
    const deps = fakeDeps({ runGuard });
    await tick({ root, now: NOW, deps });
    await tick({ root, now: NOW + MIN, deps });
    const st = readState(root).jobs.a;
    expect(st.breakerTripped).toBe(true);
    expect(st.breakerReason).toBe('guard exit 1');
    const r3 = await tick({ root, now: NOW + 2 * MIN, deps });
    expect(r3).toEqual([{ id: 'a', action: 'skipped-breaker', reason: 'guard exit 1' }]);
    expect(runGuard).toHaveBeenCalledTimes(2); // not on the tripped tick
  });

  it('a guard timeout trips with breakerReason "guard timeout"', async () => {
    guardJob({}, { maxConsecutiveFailures: 1 });
    seed();
    const deps = fakeDeps({ runGuard: vi.fn(async () => gr('error', { exit: null, timedOut: true })) });
    await tick({ root, now: NOW, deps });
    expect(readState(root).jobs.a.breakerReason).toBe('guard timeout');
  });

  // Counter separation — the §1.3 argument, encoded:
  it('run failures survive quiet slots and still trip (quiet resets ONLY the guard counter)', async () => {
    guardJob({}, { maxConsecutiveFailures: 3 });
    seed({ consecutiveFailures: 2 });
    const deps = fakeDeps({ runGuard: vi.fn(async () => gr('quiet')) });
    await tick({ root, now: NOW, deps });                          // quiet slot
    expect(readState(root).jobs.a.consecutiveFailures).toBe(2);    // survived
    const deps2 = fakeDeps({ runJob: vi.fn(async () => ({ pid: 1, exit: 1, timedOut: false, durationMs: 5, out: 'panic', err: '' })) });
    await tick({ root, now: NOW + MIN, deps: deps2 });
    const st = readState(root).jobs.a;
    expect(st.consecutiveFailures).toBe(3);
    expect(st.breakerTripped).toBe(true);
  });

  it('guard blips separated by quiets never accumulate', async () => {
    guardJob({}, { maxConsecutiveFailures: 2 });
    seed();
    const blip = fakeDeps({ runGuard: vi.fn(async () => gr('error')) });
    const quiet = fakeDeps({ runGuard: vi.fn(async () => gr('quiet')) });
    await tick({ root, now: NOW, deps: blip });
    await tick({ root, now: NOW + MIN, deps: quiet });
    await tick({ root, now: NOW + 2 * MIN, deps: blip });
    const st = readState(root).jobs.a;
    expect(st.consecutiveGuardFailures).toBe(1); // reset by the quiet in between
    expect(st.breakerTripped).toBeUndefined();
  });

  // Ordering: no guard invocation when a prior gate already decided.
  it('does not run the guard on the baseline tick, when paused, breaker-tripped, pid-alive, or not due', async () => {
    guardJob();
    const runGuard = vi.fn(async () => gr('pass'));

    // baseline (no state yet)
    let deps = fakeDeps({ runGuard });
    expect(await tick({ root, now: NOW, deps })).toEqual([{ id: 'a', action: 'baselined' }]);

    // paused
    seed();
    mkdirSync(paths(root).runDir, { recursive: true });
    writeFileSync(pausePath(root, 'a'), 'stop', 'utf-8');
    await tick({ root, now: NOW, deps: fakeDeps({ runGuard }) });
    rmSync(pausePath(root, 'a'), { force: true });

    // breaker-tripped
    seed({ breakerTripped: true, breakerReason: 'x' });
    await tick({ root, now: NOW, deps: fakeDeps({ runGuard }) });

    // pid alive
    seed({ pid: 777 });
    await tick({ root, now: NOW, deps: fakeDeps({ runGuard, isPidAlive: vi.fn(() => true) }) });

    // not due
    writeJobs(root, { version: 1, defaults: {}, jobs: [{ id: 'a', schedule: '0 0 1 1 *', enabled: true, prompt: 'go', guard: 'check' }] });
    seed();
    await tick({ root, now: NOW, deps: fakeDeps({ runGuard }) });

    expect(runGuard).not.toHaveBeenCalled();
  });

  it('reset-breaker clears the guard counter and a guard-tripped breaker', async () => {
    guardJob();
    seed({ consecutiveGuardFailures: 3, breakerTripped: true, breakerReason: 'guard exit 1', breakerAt: NOW });
    resetBreaker(root, 'a');
    const st = readState(root).jobs.a;
    expect(st.breakerTripped).toBeUndefined();
    expect(st.consecutiveGuardFailures ?? 0).toBe(0);
    expect(st.consecutiveFailures).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/tick-guard.test.ts`
Expected: FAIL — actions come back `launched` instead of `guard-quiet`/`guard-error` (tick ignores `job.guard`), and `resetBreaker` leaves `consecutiveGuardFailures: 3`.

- [ ] **Step 3: Implement tick + breaker changes**

In `plugins/p-shed/tools/lib/tick.mjs`:

Add imports/deps:

```js
import { runGuard as realRunGuard } from './guard.mjs';
```

In the `d` deps object (after `runJob: realRunJob,` line):

```js
    runGuard: (job, defaults) => realRunGuard({ job, defaults, root }),
```

Insert between the `isDue` check and the `runJob` call:

```js
    // Guard: an owner-supplied cheap command in front of the Claude launch decides,
    // per due slot, whether the launch happens (exit 0), the slot is deliberately
    // quiet (75 — EX_TEMPFAIL, see lib/guard.mjs), or the guard itself is broken
    // (anything else / timeout). Runs AFTER every gate above, so a paused / tripped /
    // pid-alive / not-due job never executes its guard, and the baseline tick skips
    // it too. A quiet guard CONSUMES the slot (lastRun = now), mirroring the
    // usage-limit skip path: a daily job whose guard said quiet retries tomorrow,
    // not every minute all day.
    let guarded;
    if (job.guard) {
      const g = await d.runGuard(job, defaults);
      const lastGuard = { at: now, outcome: g.outcome, exit: g.exit };
      const prevG = d.readJobState(root, job.id) ?? {};
      if (g.outcome === 'quiet') {
        // Log-noise policy: quiet is state-only (lastGuard) — no history line. A
        // minutely chat job must not write 1440 quiet records/day; freshness is
        // visible via status.lastGuard instead.
        d.writeJobState(root, job.id, { ...prevG, lastRun: now, lastGuard, consecutiveGuardFailures: 0 });
        results.push({ id: job.id, action: 'guard-quiet' });
        continue;
      }
      if (g.outcome === 'error') {
        // Guard errors get their own counter — reset by a healthy guard (quiet or
        // pass), NOT by a healthy run — but share the breaker and its threshold, so
        // watchdogs keyed on breakerTripped need no change. A single shared counter
        // fails both ways: guard blips weeks apart would eventually trip a healthy
        // job, while a crashing run interleaved with quiet slots would never trip.
        const consecutiveGuardFailures = (prevG.consecutiveGuardFailures ?? 0) + 1;
        const maxFailures = job.maxConsecutiveFailures ?? defaults.maxConsecutiveFailures ?? 3;
        const next = { ...prevG, lastRun: now, lastGuard, consecutiveGuardFailures };
        if (maxFailures > 0 && consecutiveGuardFailures >= maxFailures) {
          next.breakerTripped = true;
          next.breakerReason = g.timedOut ? 'guard timeout' : (g.error ? `guard: ${g.error}` : `guard exit ${g.exit}`);
          next.breakerAt = now;
        }
        d.writeJobState(root, job.id, next);
        const rawG = truncateOutput(g.out, g.err);
        d.appendLog(root, { ts: now, job: job.id, outcome: 'guard-error', exit: g.exit, timedOut: g.timedOut, durationMs: g.durationMs, ...(rawG ? { raw: rawG } : {}) }, now);
        results.push({ id: job.id, action: 'guard-error', exit: g.exit, timedOut: g.timedOut });
        continue;
      }
      // pass: the guard is proven healthy — reset its counter, record freshness,
      // fall through to the launch. The post-run read-modify-write re-reads this.
      d.writeJobState(root, job.id, { ...prevG, lastGuard, consecutiveGuardFailures: 0 });
      guarded = true;
    }
```

Tag the two launch-path `appendLog` records (usage-limit branch and success/failure branch) with the flag — add `...(guarded ? { guarded: true } : {})` to both record literals, e.g.:

```js
      d.appendLog(root, withRaw({ ts: now, job: job.id, exit: r.exit, timedOut: r.timedOut, durationMs: r.durationMs, outcome: 'skipped', reason: 'usage-limit', ...(guarded ? { guarded: true } : {}), ...(resetAt ? { resetAt } : {}) }), now);
```

and

```js
    d.appendLog(root, withRaw({ ts: now, job: job.id, exit: r.exit, timedOut: r.timedOut, durationMs: r.durationMs, outcome, ...(guarded ? { guarded: true } : {}) }), now);
```

In `plugins/p-shed/tools/lib/breaker.mjs`, `resetBreaker` gains one line after `st.consecutiveFailures = 0;`:

```js
    delete st.consecutiveGuardFailures;
```

- [ ] **Step 4: Run tests — new file AND the untouched existing suites**

Run: `npx vitest run plugins/p-shed`
Expected: PASS — all p-shed suites green (existing `tick.test.ts` proves guardless jobs are unchanged).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/tick.mjs plugins/p-shed/tools/lib/breaker.mjs plugins/p-shed/tools/__tests__/tick-guard.test.ts
git commit -m "feat(p-shed): tick honors job guards — quiet slots, guard-error counter, shared breaker"
```

---

### Task 3: Schema — `set-job --guard` / `--guard-timeout-sec`

**Files:**
- Modify: `plugins/p-shed/tools/lib/jobs.mjs` (validation + field wiring in both branches of `setJob`)
- Modify: `plugins/p-shed/tools/pshed.mjs` (`set-job` arg mapping, ~line 104)
- Test: `plugins/p-shed/tools/__tests__/jobs-guard.test.ts`

**Interfaces:**
- Consumes: existing `setJob(root, spec)` / `pruneUndefined`.
- Produces: `spec.guard?: string` (`''` clears guard AND guardTimeoutSec — resolution A6), `spec.guardTimeoutSec?: number` (positive). `ValidationError` (exit 2) otherwise.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-shed/tools/__tests__/jobs-guard.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setJob, ValidationError } from '../lib/jobs.mjs';
import { readJobs } from '../lib/io.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pshed-jobsguard-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const base = { id: 'a', schedule: '* * * * *', prompt: 'go' };
const jobA = () => readJobs(root).jobs.find((j) => j.id === 'a')!;

describe('setJob guard schema', () => {
  it('persists guard and guardTimeoutSec on create', () => {
    setJob(root, { ...base, guard: 'pchat guard', guardTimeoutSec: 120 });
    expect(jobA()).toMatchObject({ guard: 'pchat guard', guardTimeoutSec: 120 });
  });

  it('round-trips through an update, preserving unrelated fields', () => {
    setJob(root, { ...base, model: 'sonnet' });
    setJob(root, { id: 'a', guard: 'check' });
    expect(jobA()).toMatchObject({ guard: 'check', model: 'sonnet', prompt: 'go' });
  });

  it('guard: "" clears guard AND guardTimeoutSec (resolution A6)', () => {
    setJob(root, { ...base, guard: 'check', guardTimeoutSec: 60 });
    setJob(root, { id: 'a', guard: '' });
    const j = jobA();
    expect(j.guard).toBeUndefined();
    expect(j.guardTimeoutSec).toBeUndefined();
  });

  it('creating a job with guard: "" simply omits the field', () => {
    setJob(root, { ...base, guard: '' });
    expect(jobA().guard).toBeUndefined();
  });

  it('rejects a non-string guard (bare --guard flag arrives as true)', () => {
    expect(() => setJob(root, { ...base, guard: true as never })).toThrow(ValidationError);
  });

  it.each([0, -5, NaN])('rejects guardTimeoutSec = %s', (v) => {
    expect(() => setJob(root, { ...base, guardTimeoutSec: v as number })).toThrow(ValidationError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/jobs-guard.test.ts`
Expected: FAIL — `guard` never persisted (`toMatchObject` mismatch), invalid values not rejected.

- [ ] **Step 3: Implement**

In `plugins/p-shed/tools/lib/jobs.mjs`, after the `EFFORT_LEVELS` validation inside `setJob`:

```js
  // guard: a shell command; '' is the documented clear sentinel (--guard "").
  if (spec.guard !== undefined && typeof spec.guard !== 'string') {
    throw new ValidationError('guard must be a string command (use --guard "" to clear)');
  }
  if (spec.guardTimeoutSec !== undefined && (!Number.isFinite(spec.guardTimeoutSec) || spec.guardTimeoutSec <= 0)) {
    throw new ValidationError(`invalid guardTimeoutSec: ${spec.guardTimeoutSec} (expected a positive number)`);
  }
```

In the `existing` branch, extend the `pruneUndefined({...})` object with:

```js
      guard: spec.guard || undefined,          // '' falls through to the delete below
      guardTimeoutSec: spec.guardTimeoutSec,
```

and immediately after the `Object.assign(...)` line:

```js
    // Clearing the guard also clears its timeout — an orphaned guardTimeoutSec is
    // meaningless (resolution A6).
    if (spec.guard === '') { delete existing.guard; delete existing.guardTimeoutSec; }
```

In the create branch, extend the pushed object with:

```js
    guard: spec.guard || undefined,
    guardTimeoutSec: spec.guardTimeoutSec,
```

In `plugins/p-shed/tools/pshed.mjs`, extend the `set-job` spec object:

```js
        guard: args.guard,
        guardTimeoutSec: args['guard-timeout-sec'] !== undefined ? Number(args['guard-timeout-sec']) : undefined,
```

(A bare `--guard` parses to `true` and is rejected by the new validation; `--guard-timeout-sec abc` becomes `NaN` and is rejected.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run plugins/p-shed`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/jobs.mjs plugins/p-shed/tools/pshed.mjs plugins/p-shed/tools/__tests__/jobs-guard.test.ts
git commit -m "feat(p-shed): set-job --guard / --guard-timeout-sec with clear-on-empty semantics"
```

---

### Task 4: `status` surfaces guard freshness

**Files:**
- Modify: `plugins/p-shed/tools/lib/status.mjs` (job fields + human table column; `formatHuman` gains an injectable `now`)
- Modify: `plugins/p-shed/tools/pshed.mjs` (no change needed — `formatHuman(status)` keeps its default arg)
- Test: `plugins/p-shed/tools/__tests__/status-guard.test.ts`

**Interfaces:**
- Consumes: state fields `lastGuard` / `consecutiveGuardFailures` from Task 2.
- Produces: per-job status fields `lastGuard` (object or undefined) and `consecutiveGuardFailures` (number, default 0); `formatHuman(status, now = Date.now())` renders a `guard` column `"<outcome> <age>s ago"` or `-`.

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-shed/tools/__tests__/status-guard.test.ts
import { describe, expect, it } from 'vitest';
import { collectStatus, formatHuman } from '../lib/status.mjs';

const NOW = 1_753_000_000_000;

const deps = (state: Record<string, unknown>) => ({
  readJobs: () => ({ defaults: {}, jobs: [{ id: 'a', schedule: '* * * * *', enabled: true, prompt: 'go', guard: 'check' }] }),
  readJobState: () => state,
  readPause: () => null,
  readGlobalPause: () => null,
  readPid: () => null,
  isPidAlive: () => false,
});

describe('status + guard', () => {
  it('surfaces lastGuard and consecutiveGuardFailures per job', () => {
    const s = collectStatus('/nowhere', {
      installed: false,
      deps: deps({ lastRun: NOW - 40_000, lastGuard: { at: NOW - 40_000, outcome: 'quiet', exit: 75 }, consecutiveGuardFailures: 1 }),
    });
    expect(s.jobs[0].lastGuard).toMatchObject({ outcome: 'quiet', exit: 75 });
    expect(s.jobs[0].consecutiveGuardFailures).toBe(1);
  });

  it('formatHuman shows guard outcome + freshness ("checked 40 s ago" stays visible)', () => {
    const s = collectStatus('/nowhere', {
      installed: false,
      deps: deps({ lastRun: NOW - 40_000, lastGuard: { at: NOW - 40_000, outcome: 'quiet', exit: 75 } }),
    });
    const text = formatHuman(s, NOW);
    expect(text).toContain('guard');
    expect(text).toContain('quiet 40s ago');
  });

  it('a guardless job shows "-" and zero guard failures', () => {
    const s = collectStatus('/nowhere', { installed: false, deps: deps({ lastRun: 1 }) });
    expect(s.jobs[0].consecutiveGuardFailures).toBe(0);
    expect(s.jobs[0].lastGuard).toBeUndefined();
    const line = formatHuman(s, NOW).split('\n').at(-1)!;
    expect(line.endsWith('-')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/status-guard.test.ts`
Expected: FAIL — `lastGuard`/`consecutiveGuardFailures` undefined, no `guard` column.

- [ ] **Step 3: Implement**

In `collectStatus`'s per-job object (after `lastSkipResetAt: st.lastSkipResetAt,`):

```js
      // Guard freshness ("checked 40 s ago") + its failure counter. Undefined /
      // 0 for guardless jobs.
      lastGuard: st.lastGuard,
      consecutiveGuardFailures: st.consecutiveGuardFailures ?? 0,
```

In `formatHuman`, change the signature to `export function formatHuman(status, now = Date.now())`, add `'guard'` to the header array after `'lastSkip'`, and per row:

```js
    const guard = j.lastGuard
      ? `${j.lastGuard.outcome} ${Math.max(0, Math.round((now - j.lastGuard.at) / 1000))}s ago`
      : '-';
```

appending `guard` as the final column of the row array.

- [ ] **Step 4: Run tests**

Run: `npx vitest run plugins/p-shed`
Expected: PASS (including the existing `status.test.ts` and the `status --human` e2e, which only assert on existing columns).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/status.mjs plugins/p-shed/tools/__tests__/status-guard.test.ts
git commit -m "feat(p-shed): status surfaces lastGuard freshness and guard failure counter"
```

---

### Task 5: `run <id>` respects the guard; `--no-guard` bypasses; full-path e2e

**Files:**
- Modify: `plugins/p-shed/tools/pshed.mjs` (`run` command; import `runGuard`)
- Test: `plugins/p-shed/tools/__tests__/cli-guard-e2e.test.ts`

**Interfaces:**
- Consumes: `runGuard` (Task 1), `truncateOutput` (already imported in pshed.mjs).
- Produces: `run` output `{ id, outcome: 'guard-quiet' | 'guard-error', guard: { exit, timedOut, durationMs, raw? } }`, exit 0, **no state/log mutation** (resolution A5).

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-shed/tools/__tests__/cli-guard-e2e.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cli-guard-e2e.test.ts`
Expected: The set-job/tick cases PASS already (Tasks 2–3); the final `run <id>` case FAILS — `run` launches despite the quiet guard. (If any tick case fails too, fix before proceeding.)

- [ ] **Step 3: Implement `run` guard support**

In `plugins/p-shed/tools/pshed.mjs`: add to the imports from `./lib/guard.mjs`:

```js
import { runGuard } from './lib/guard.mjs';
```

In the `run` command, after resolving `job` and before `const result = await runJob(...)`:

```js
      // Manual runs respect the guard (--no-guard bypasses for debugging) but stay
      // STATELESS: no counters, no history log — exactly like guardless `run` today
      // (resolution A5).
      if (job.guard && !args['no-guard']) {
        const g = await runGuard({ job, defaults, root });
        if (g.outcome !== 'pass') {
          const raw = truncateOutput(g.out, g.err);
          return emitJson({ id, outcome: `guard-${g.outcome}`, guard: { exit: g.exit, timedOut: g.timedOut, durationMs: g.durationMs, ...(raw ? { raw } : {}) } }, 0);
        }
      }
```

- [ ] **Step 4: Run the full p-shed suite**

Run: `npx vitest run plugins/p-shed`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/pshed.mjs plugins/p-shed/tools/__tests__/cli-guard-e2e.test.ts
git commit -m "feat(p-shed): run <id> respects guards, --no-guard bypasses; guard e2e coverage"
```

---

### Task 6: p-shed docs — README, job skill, contributor guide, manifest description

**Files:**
- Modify: `plugins/p-shed/README.md`
- Modify: `plugins/p-shed/skills/job/SKILL.md`
- Modify: `plugins/p-shed/CLAUDE.md`
- Modify: `plugins/p-shed/.claude-plugin/plugin.json` (description text only — **version stays 0.5.0**; bumps happen only at release)

**Interfaces:** none (docs).

- [ ] **Step 1: README — Formats table**

In the `jobs.yml` row, extend the field list to `jobs[]{ id, schedule, enabled, cwd?, prompt, timeoutSec?, permissionMode?, allowedTools?, model?, effort?, maxConsecutiveFailures?, guard?, guardTimeoutSec? }`. In the `state/<id>.json` row, extend to `{ lastRun, lastExit, pid, consecutiveFailures, consecutiveGuardFailures?, lastGuard?, breakerTripped?, ... }` and append to the row's note: `lastGuard` records the most recent guard check (`{ at, outcome, exit }`).

- [ ] **Step 2: README — Commands table**

`run` row → `run <id> [--no-guard]` … add "Respects the job's guard; `--no-guard` bypasses it for debugging." `set-job` row → add `--guard`, `--guard-timeout-sec` to the flag list.

- [ ] **Step 3: README — new section after "Reasoning effort"**

```markdown
## Job guards

A **guard** is an optional cheap shell command in front of a job's Claude launch. On
each due tick — after every other gate (global pause, self-pause, breaker, live pid) —
p-shed runs `guard` (`shell: true`, cwd = the job's `cwd` else `defaults.cwd` else the
repo root, env + `PSHED_JOB_ID` / `PSHED_ROOT`, killed after `guardTimeoutSec`,
default 30 s) and reads only its exit code:

| Exit | Meaning | Effect |
|---|---|---|
| `0` | work exists | launch `claude -p` as usual (log record gains `guarded: true`) |
| `75` | deliberately quiet — no work this slot | skip silently; **not** a failure |
| anything else, or timeout | guard is broken | skip + `consecutiveGuardFailures`+1 → shared breaker |

Why 75: it is `EX_TEMPFAIL` in `sysexits.h` ("temporary failure, try again later") and
no crashing tool emits it by accident — crashes exit 1/2, "not found" is 127. A guard
author writes `exit 75` deliberately, so an accidentally broken guard always surfaces
as an error instead of reading as eternal quiet.

Semantics worth knowing:

- **A quiet guard consumes the schedule slot** (like a usage-limit skip): a daily job
  whose guard said quiet at 09:00 next tries tomorrow — it does not re-poll all day.
- **Two failure counters, one breaker.** Guard errors increment
  `consecutiveGuardFailures` (reset by any healthy guard result); run failures keep
  `consecutiveFailures`. Either reaching `maxConsecutiveFailures` trips the same
  breaker; `reset-breaker` clears both.
- **Quiet is silent**: no history-log line (a minutely job must not write 1440
  lines/day) — freshness is visible in `status` (`lastGuard`, e.g. `quiet 40s ago`).
  `guard-error` and launches do log.
- `run <id>` respects the guard; `--no-guard` bypasses it. Manual runs stay stateless.
- Windows: the guard runs via `cmd.exe`, where `~` does not expand — use real paths in
  guard commands.

### Guard-only jobs (free scheduled commands)

A job whose guard does the work and exits 75 never launches Claude but keeps full
p-shed supervision (breaker, `status`): in `cmd && exit 75` a failing `cmd`
short-circuits the `&&`, the guard exits with `cmd`'s code, and the breaker path
fires. `prompt` stays required as documentation of what the guard does.

    - id: session-clean
      schedule: "0 4 * * *"
      guard: "node tools/clean.mjs && exit 75"
      prompt: "(guard-only) Nightly cleanup; the guard does the work."
```

- [ ] **Step 4: skills/job/SKILL.md**

In the "Add or modify" paragraph, after the `maxConsecutiveFailures` clause, add: `optional guard (a shell command run before each due launch: exit 0 ⇒ launch, exit 75 ⇒ quiet skip, anything else ⇒ guard error counting toward the breaker; pass --guard "" to clear) and optional guardTimeoutSec (seconds before the guard is killed; default 30).` Extend the `set-job` command line with `[--guard "<cmd>"] [--guard-timeout-sec <n>]`.

- [ ] **Step 5: CLAUDE.md contributor bullet**

Append:

```markdown
- **Guards: one breaker, two counters, exit 75.** A job's optional `guard` command
  (lib/guard.mjs) runs after all other gates and before the launch; 0 = launch,
  75 = quiet skip (EX_TEMPFAIL — deliberate, so a crash can never read as quiet;
  do NOT "simplify" to 0/nonzero), else = guard error. Guard errors have their own
  `consecutiveGuardFailures` (reset by any healthy guard result, not by a healthy
  run) but trip the same breaker. Quiet skips consume the schedule slot and write
  NO history-log line — state (`lastGuard`) + `status` only. `run <id>` respects
  the guard (`--no-guard` bypasses) and stays stateless.
```

- [ ] **Step 6: plugin.json description**

Extend the description sentence list with: `Optional per-job guard command gates each launch (exit 0 = launch, 75 = quiet skip, else breaker-counted error) — guard-only jobs give free scheduled commands under full supervision.` Leave `version` at `0.5.0`.

- [ ] **Step 7: Run the full suite (README-coverage and skills tests are static)**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add plugins/p-shed/README.md plugins/p-shed/skills/job/SKILL.md plugins/p-shed/CLAUDE.md plugins/p-shed/.claude-plugin/plugin.json
git commit -m "docs(p-shed): document job guards — contract, guard-only pattern, set-job flags"
```

---

## Part B — p-chat plugin

File map (all under `plugins/p-chat/`): `tools/pchat.mjs` (CLI), `tools/lib/config.mjs` (config+token+root), `tools/lib/state.mjs` (offset/session/local log/gitignore), `tools/lib/queue.mjs` (pure classify/pending), `tools/lib/split.mjs` (4096 splitter), `tools/lib/api.mjs` (fetch client), `tools/lib/exec.mjs` (bounded shell runner), `tools/lib/send.mjs` (split+markdown-fallback delivery), `tools/lib/core.mjs` (guard scan, pending, init) — plus `skills/init`, `skills/respond`, README, CLAUDE.md, `.claude-plugin/plugin.json` (created LAST so root static suites only see the finished plugin).

### Task 7: config + state foundations

**Files:**
- Create: `plugins/p-chat/tools/lib/config.mjs`
- Create: `plugins/p-chat/tools/lib/state.mjs`
- Test: `plugins/p-chat/tools/__tests__/config.test.ts`, `plugins/p-chat/tools/__tests__/state.test.ts`

**Interfaces (produces):**
- `config.mjs`: `class ConfigError extends Error`; `findRoot(startDir)`; `paths(root) -> { dir, config, offset, log }` (`.pchat.json` at root, state under `.pchat/`); `expandHome(p)`; `readConfig(root)` (throws ConfigError when missing/corrupt; merges defaults `{ apiBase: 'https://api.telegram.org', sessionFile: '.pchat/session.md', commandTimeoutSec: 15, apiTimeoutSec: 10, commands: {} }`); `requireAllowlist(cfg) -> number[]` (throws on empty/missing); `readToken(cfg, root) -> string` (trimmed; throws on missing/empty); `resolveTokenPath(p, root)`; `tokenPermsWarning(cfg, root) -> string|null` (POSIX-only; null on win32).
- `state.mjs`: `readOffset(root) -> { confirmed: number, lastPollAt: number|null }` (tolerant of missing/corrupt); `writeOffset(root, offset)`; `ackUntil(root, until) -> offset` (throws ConfigError on non-integer or `until < confirmed`); `appendLocalLog(root, rec)`; `sessionPath(root, cfg)`; `resetSession(root, cfg) -> path`; `sessionStatus(root, cfg) -> { file, bytes }`; `ensureGitignore(root) -> boolean` (adds `.pchat/` line once).

- [ ] **Step 1: Write the failing tests**

```ts
// plugins/p-chat/tools/__tests__/config.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, expandHome, paths, readConfig, readToken, requireAllowlist, tokenPermsWarning } from '../lib/config.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pchat-config-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const writeCfg = (obj: Record<string, unknown>) =>
  writeFileSync(paths(root).config, JSON.stringify(obj), 'utf-8');

describe('config', () => {
  it('readConfig throws ConfigError when .pchat.json is missing', () => {
    expect(() => readConfig(root)).toThrow(ConfigError);
  });

  it('readConfig merges defaults (apiBase, sessionFile, commandTimeoutSec, commands)', () => {
    writeCfg({ tokenFile: 't', allowedChatIds: [1] });
    const cfg = readConfig(root);
    expect(cfg.apiBase).toBe('https://api.telegram.org');
    expect(cfg.sessionFile).toBe('.pchat/session.md');
    expect(cfg.commandTimeoutSec).toBe(15);
    expect(cfg.commands).toEqual({});
  });

  it('requireAllowlist rejects an empty or missing allowlist (fail-closed)', () => {
    expect(() => requireAllowlist({})).toThrow(ConfigError);
    expect(() => requireAllowlist({ allowedChatIds: [] })).toThrow(ConfigError);
    expect(requireAllowlist({ allowedChatIds: [7] })).toEqual([7]);
  });

  it('expandHome expands ~/ to the home directory', () => {
    expect(expandHome('~/x/y')).toBe(join(homedir(), 'x/y'));
    expect(expandHome('/abs/path')).toBe('/abs/path');
  });

  it('readToken reads and trims the token file, relative to root', () => {
    writeFileSync(join(root, 'tok'), '  123:ABC \n', 'utf-8');
    expect(readToken({ tokenFile: 'tok' }, root)).toBe('123:ABC');
  });

  it('readToken throws on a missing or empty token file', () => {
    expect(() => readToken({ tokenFile: 'nope' }, root)).toThrow(ConfigError);
    writeFileSync(join(root, 'empty'), '  \n', 'utf-8');
    expect(() => readToken({ tokenFile: 'empty' }, root)).toThrow(ConfigError);
    expect(() => readToken({}, root)).toThrow(ConfigError);
  });

  it.runIf(process.platform !== 'win32')('tokenPermsWarning warns on group/other-readable modes (POSIX)', () => {
    writeFileSync(join(root, 'tok'), 'x', 'utf-8');
    chmodSync(join(root, 'tok'), 0o644);
    expect(tokenPermsWarning({ tokenFile: 'tok' }, root)).toMatch(/chmod 600/);
    chmodSync(join(root, 'tok'), 0o600);
    expect(tokenPermsWarning({ tokenFile: 'tok' }, root)).toBeNull();
  });

  it.runIf(process.platform === 'win32')('tokenPermsWarning is null on Windows (mode is meaningless)', () => {
    writeFileSync(join(root, 'tok'), 'x', 'utf-8');
    expect(tokenPermsWarning({ tokenFile: 'tok' }, root)).toBeNull();
  });
});
```

```ts
// plugins/p-chat/tools/__tests__/state.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, paths } from '../lib/config.mjs';
import { ackUntil, appendLocalLog, ensureGitignore, readOffset, resetSession, sessionPath, sessionStatus, writeOffset } from '../lib/state.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pchat-state-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('offset state', () => {
  it('reads a zero cursor when no offset file exists', () => {
    expect(readOffset(root)).toEqual({ confirmed: 0, lastPollAt: null });
  });

  it('round-trips the cursor', () => {
    writeOffset(root, { confirmed: 42, lastPollAt: 1000 });
    expect(readOffset(root)).toEqual({ confirmed: 42, lastPollAt: 1000 });
  });

  it('tolerates a corrupt offset file (treated as zero)', () => {
    mkdirSync(paths(root).dir, { recursive: true });
    writeFileSync(paths(root).offset, '{oops', 'utf-8');
    expect(readOffset(root).confirmed).toBe(0);
  });

  it('ackUntil advances the cursor and is idempotent at the same id', () => {
    writeOffset(root, { confirmed: 10, lastPollAt: null });
    expect(ackUntil(root, 15).confirmed).toBe(15);
    expect(ackUntil(root, 15).confirmed).toBe(15);
  });

  it('ackUntil REFUSES to move backwards (monotonicity)', () => {
    writeOffset(root, { confirmed: 10, lastPollAt: null });
    expect(() => ackUntil(root, 5)).toThrow(ConfigError);
    expect(readOffset(root).confirmed).toBe(10);
  });

  it('ackUntil rejects non-integer ids', () => {
    expect(() => ackUntil(root, NaN)).toThrow(ConfigError);
    expect(() => ackUntil(root, 1.5)).toThrow(ConfigError);
  });
});

describe('session + local log + gitignore', () => {
  const cfg = { sessionFile: '.pchat/session.md' };

  it('resetSession truncates (and creates) the session file', () => {
    const p = resetSession(root, cfg);
    expect(p).toBe(sessionPath(root, cfg));
    writeFileSync(p, 'Q/A history', 'utf-8');
    expect(sessionStatus(root, cfg).bytes).toBeGreaterThan(0);
    resetSession(root, cfg);
    expect(sessionStatus(root, cfg).bytes).toBe(0);
  });

  it('sessionStatus reports 0 bytes for a missing file', () => {
    expect(sessionStatus(root, cfg).bytes).toBe(0);
  });

  it('appendLocalLog appends JSONL records', () => {
    appendLocalLog(root, { ts: 1, event: 'skipped-update' });
    appendLocalLog(root, { ts: 2, event: 'split' });
    const lines = readFileSync(paths(root).log, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe('skipped-update');
  });

  it('ensureGitignore adds .pchat/ once', () => {
    expect(ensureGitignore(root)).toBe(true);
    expect(ensureGitignore(root)).toBe(false);
    const gi = readFileSync(join(root, '.gitignore'), 'utf-8');
    expect(gi.match(/\.pchat\//g)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run plugins/p-chat`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement `config.mjs`**

```js
// plugins/p-chat/tools/lib/config.mjs
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// Config / validation errors -> exit 2 at the CLI (visible to p-shed as a broken
// guard, never as quiet).
export class ConfigError extends Error {}

export function findRoot(startDir) {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}

export function paths(root) {
  const dir = join(root, '.pchat');
  return {
    dir,
    config: join(root, '.pchat.json'), // committed; contains no secrets
    offset: join(dir, 'offset.json'),  // gitignored state
    log: join(dir, 'log.jsonl'),       // local channel log
  };
}

export function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

const DEFAULTS = {
  apiBase: 'https://api.telegram.org', // overridable: the test seam for the mock Bot API
  sessionFile: '.pchat/session.md',
  commandTimeoutSec: 15,
  apiTimeoutSec: 10,
};

export function readConfig(root) {
  const p = paths(root).config;
  if (!existsSync(p)) throw new ConfigError('.pchat.json not found — run pchat init first');
  let cfg;
  try { cfg = JSON.parse(readFileSync(p, 'utf-8')); }
  catch (e) { throw new ConfigError(`.pchat.json is not valid JSON: ${e.message}`); }
  return { ...DEFAULTS, commands: {}, ...cfg };
}

// Fail-closed allowlist: an empty/missing allowlist is a hard error (exit 2 ->
// p-shed guard-error -> breaker -> visible), never "respond to anyone".
export function requireAllowlist(cfg) {
  if (!Array.isArray(cfg.allowedChatIds) || cfg.allowedChatIds.length === 0) {
    throw new ConfigError('allowedChatIds must be a non-empty array in .pchat.json');
  }
  return cfg.allowedChatIds;
}

export function resolveTokenPath(p, root) {
  const e = expandHome(p);
  return isAbsolute(e) ? e : resolve(root, e);
}

// The token lives ONLY in this file — never argv, env dumps, repo files, or logs.
export function readToken(cfg, root) {
  if (!cfg.tokenFile) throw new ConfigError('tokenFile missing from .pchat.json');
  const p = resolveTokenPath(cfg.tokenFile, root);
  if (!existsSync(p)) throw new ConfigError(`token file not found: ${p}`);
  const token = readFileSync(p, 'utf-8').trim();
  if (!token) throw new ConfigError(`token file is empty: ${p}`);
  return token;
}

// POSIX-only 600 check (file mode is meaningless on Windows). Warn, don't fail.
export function tokenPermsWarning(cfg, root) {
  if (process.platform === 'win32') return null;
  try {
    const p = resolveTokenPath(cfg.tokenFile, root);
    const mode = statSync(p).mode & 0o777;
    if (mode & 0o077) return `token file ${p} is mode ${mode.toString(8)} — chmod 600 it`;
  } catch { return null; }
  return null;
}
```

- [ ] **Step 4: Implement `state.mjs`**

```js
// plugins/p-chat/tools/lib/state.mjs
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ConfigError, paths } from './config.mjs';

export function readOffset(root) {
  const p = paths(root).offset;
  if (!existsSync(p)) return { confirmed: 0, lastPollAt: null };
  try { return { confirmed: 0, lastPollAt: null, ...JSON.parse(readFileSync(p, 'utf-8')) }; }
  catch { return { confirmed: 0, lastPollAt: null }; } // corrupt -> safe zero (re-serve, never skip)
}

export function writeOffset(root, offset) {
  mkdirSync(paths(root).dir, { recursive: true });
  writeFileSync(paths(root).offset, JSON.stringify(offset, null, 2) + '\n', 'utf-8');
}

// Monotonic by contract: Telegram confirms EVERYTHING below the offset, so moving
// the cursor backwards can only re-serve already-answered messages — a caller
// acking a stale id is a bug worth surfacing, not silently clamping.
export function ackUntil(root, until) {
  if (!Number.isInteger(until) || until < 0) throw new ConfigError(`invalid --until: ${until} (expected an update_id)`);
  const cur = readOffset(root);
  if (until < cur.confirmed) throw new ConfigError(`cannot ack backwards: confirmed=${cur.confirmed}, until=${until}`);
  const next = { ...cur, confirmed: until };
  writeOffset(root, next);
  return next;
}

export function appendLocalLog(root, rec) {
  mkdirSync(paths(root).dir, { recursive: true });
  appendFileSync(paths(root).log, JSON.stringify(rec) + '\n', 'utf-8');
}

export function sessionPath(root, cfg) {
  const p = cfg.sessionFile ?? '.pchat/session.md';
  return isAbsolute(p) ? p : resolve(root, p);
}

export function resetSession(root, cfg) {
  const p = sessionPath(root, cfg);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '', 'utf-8');
  return p;
}

export function sessionStatus(root, cfg) {
  const p = sessionPath(root, cfg);
  try { return { file: p, bytes: statSync(p).size }; }
  catch { return { file: p, bytes: 0 }; }
}

export function ensureGitignore(root) {
  const p = join(root, '.gitignore');
  const line = '.pchat/';
  const cur = existsSync(p) ? readFileSync(p, 'utf-8') : '';
  if (cur.split(/\r?\n/).includes(line)) return false;
  writeFileSync(p, cur + (cur === '' || cur.endsWith('\n') ? '' : '\n') + line + '\n', 'utf-8');
  return true;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run plugins/p-chat`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-chat/tools/lib/config.mjs plugins/p-chat/tools/lib/state.mjs plugins/p-chat/tools/__tests__/config.test.ts plugins/p-chat/tools/__tests__/state.test.ts
git commit -m "feat(p-chat): config + offset/session state foundations"
```

---

### Task 8: pure logic — queue classification and message splitting

**Files:**
- Create: `plugins/p-chat/tools/lib/queue.mjs`, `plugins/p-chat/tools/lib/split.mjs`
- Test: `plugins/p-chat/tools/__tests__/queue.test.ts`, `plugins/p-chat/tools/__tests__/split.test.ts`

**Interfaces (produces):**
- `queue.mjs`: `classifyUpdate(u, cfg) -> { updateId, kind: 'command'|'free'|'other', chatId?, command?, text?, date? }`; `pendingFreeTexts(updates, cfg) -> Array<{ updateId, chatId, text, date }>` (contiguous free-text prefix; STOPS before the first command — resolution B1).
- `split.mjs`: `TELEGRAM_MAX = 4096`; `splitMessage(text, max = TELEGRAM_MAX) -> string[]` (prefers newline boundaries, never splits a surrogate pair, `[]` for empty).

- [ ] **Step 1: Write the failing tests**

```ts
// plugins/p-chat/tools/__tests__/queue.test.ts
import { describe, expect, it } from 'vitest';
import { classifyUpdate, pendingFreeTexts } from '../lib/queue.mjs';

const cfg = { allowedChatIds: [111], commands: { '/status': 'echo ok', '/jobs': 'echo jobs' } };
let id = 0;
const msg = (chatId: number, text?: string, extra: Record<string, unknown> = {}) =>
  ({ update_id: ++id, message: { message_id: id, date: 1_750_000_000, chat: { id: chatId }, ...(text !== undefined ? { text } : {}), ...extra } });

describe('classifyUpdate — the injection boundary', () => {
  it('an exact command match (after trim) from an allowed chat is a command', () => {
    expect(classifyUpdate(msg(111, '  /status '), cfg)).toMatchObject({ kind: 'command', command: '/status', chatId: 111 });
  });

  it('free text from an allowed chat is free', () => {
    expect(classifyUpdate(msg(111, 'how is the loop doing?'), cfg)).toMatchObject({ kind: 'free', text: 'how is the loop doing?' });
  });

  it('NO prefix match and NO interpolation: "/status; echo pwned" is free text, not a command', () => {
    expect(classifyUpdate(msg(111, '/status; echo pwned'), cfg).kind).toBe('free');
    expect(classifyUpdate(msg(111, '/status extra-arg'), cfg).kind).toBe('free');
  });

  it('a command word from a NON-allowed chat is other (never replied, never executed)', () => {
    expect(classifyUpdate(msg(999, '/status'), cfg).kind).toBe('other');
  });

  it('non-text updates (stickers, service events) are other', () => {
    expect(classifyUpdate(msg(111, undefined, { sticker: {} }), cfg).kind).toBe('other');
    expect(classifyUpdate({ update_id: ++id, my_chat_member: {} } as never, cfg).kind).toBe('other');
  });

  it('does not treat Object.prototype members as commands', () => {
    expect(classifyUpdate(msg(111, 'constructor'), cfg).kind).toBe('free');
  });
});

describe('pendingFreeTexts — contiguous prefix, stop before the first command (B1)', () => {
  it('returns [q1] for [q1, /status, q2] — acking q1 must not confirm the unexecuted /status', () => {
    const q1 = msg(111, 'question one');
    const cmd = msg(111, '/status');
    const q2 = msg(111, 'question two');
    const got = pendingFreeTexts([q1, cmd, q2], cfg);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ updateId: q1.update_id, text: 'question one' });
  });

  it('collects consecutive questions and skips "other" noise in between', () => {
    const q1 = msg(111, 'q1');
    const noise = msg(999, 'spam');
    const q2 = msg(111, 'q2');
    expect(pendingFreeTexts([q1, noise, q2], cfg).map((p) => p.text)).toEqual(['q1', 'q2']);
  });

  it('returns [] when the queue starts with a command or is empty', () => {
    expect(pendingFreeTexts([msg(111, '/status'), msg(111, 'q')], cfg)).toEqual([]);
    expect(pendingFreeTexts([], cfg)).toEqual([]);
  });
});
```

```ts
// plugins/p-chat/tools/__tests__/split.test.ts
import { describe, expect, it } from 'vitest';
import { splitMessage, TELEGRAM_MAX } from '../lib/split.mjs';

describe('splitMessage', () => {
  it('returns short text as a single chunk and [] for empty', () => {
    expect(splitMessage('hi')).toEqual(['hi']);
    expect(splitMessage('')).toEqual([]);
  });

  it('exactly 4096 chars stays one chunk', () => {
    expect(splitMessage('x'.repeat(TELEGRAM_MAX))).toHaveLength(1);
  });

  it('splits oversized text into <= 4096 chunks that reassemble losslessly (hard cut, no newlines)', () => {
    const text = 'x'.repeat(10_000);
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX);
    expect(chunks.join('')).toBe(text);
  });

  it('prefers a newline boundary near the limit', () => {
    const text = 'a'.repeat(4000) + '\n' + 'b'.repeat(500);
    const chunks = splitMessage(text);
    expect(chunks).toEqual(['a'.repeat(4000), 'b'.repeat(500)]);
  });

  it('never splits a surrogate pair', () => {
    const text = '💩'.repeat(3000); // 6000 UTF-16 units
    const chunks = splitMessage(text);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX);
      // A lone surrogate at a boundary would make the chunk ill-formed.
      expect(() => new TextEncoder().encode(c)).not.toThrow();
      expect(c).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
    }
    expect(chunks.join('')).toBe(text);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run plugins/p-chat`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement `queue.mjs`**

```js
// plugins/p-chat/tools/lib/queue.mjs
// Pure queue logic. THE INJECTION BOUNDARY lives here: a message either EXACTLY
// equals a configured command key (after trim) or it is free text — message text is
// never interpolated into a shell line, never prefix-matched.

export function classifyUpdate(u, cfg) {
  const updateId = u.update_id;
  const msg = u.message;
  const text = typeof msg?.text === 'string' ? msg.text : null;
  const chatId = msg?.chat?.id;
  const allowed = Array.isArray(cfg.allowedChatIds) && cfg.allowedChatIds.includes(chatId);
  if (text == null || !allowed) {
    // Non-text updates (stickers, photos, edits, service updates) and messages from
    // non-allowlisted chats: the caller logs them locally and the cursor advances
    // past — never a reply (resolution B4).
    return { updateId, kind: 'other', chatId };
  }
  const trimmed = text.trim();
  if (Object.prototype.hasOwnProperty.call(cfg.commands ?? {}, trimmed)) {
    return { updateId, kind: 'command', chatId, command: trimmed };
  }
  return { updateId, kind: 'free', chatId, text, date: msg.date };
}

// The responder's read view: the CONTIGUOUS PREFIX of free-text messages, stopping
// BEFORE the first scripted command (resolution B1). Stopping matters: the responder
// acks up to the last answered question and Telegram confirms everything below that
// offset — a /command inside the acked range would be confirmed UNEXECUTED. It runs
// on the next guard pass instead. 'other' updates are skipped (nothing to answer).
export function pendingFreeTexts(updates, cfg) {
  const out = [];
  for (const u of updates) {
    const c = classifyUpdate(u, cfg);
    if (c.kind === 'command') break;
    if (c.kind === 'free') out.push({ updateId: c.updateId, chatId: c.chatId, text: c.text, date: c.date });
  }
  return out;
}
```

- [ ] **Step 4: Implement `split.mjs`**

```js
// plugins/p-chat/tools/lib/split.mjs
// Telegram caps message text at 4096 characters. Split long text into chunks,
// preferring newline boundaries, never splitting a UTF-16 surrogate pair.
export const TELEGRAM_MAX = 4096;

export function splitMessage(text, max = TELEGRAM_MAX) {
  const s = String(text);
  if (s.length === 0) return [];
  if (s.length <= max) return [s];
  const chunks = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut <= 0) cut = max; // no usable newline -> hard cut
    if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1; // never orphan a surrogate pair
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    if (rest.startsWith('\n')) rest = rest.slice(1); // the boundary newline is consumed, not lost content
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff;
```

(Newline-lossless invariant: `chunks.join('')` equals the original only for hard cuts; when a newline boundary is used the joining newline is consumed — the newline test asserts the two parts, not the join.)

- [ ] **Step 5: Run tests**

Run: `npx vitest run plugins/p-chat`
Expected: PASS. If the `reassemble losslessly` test fails on the newline-consumption edge (input has no newlines so it must pass), fix the implementation, not the test.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-chat/tools/lib/queue.mjs plugins/p-chat/tools/lib/split.mjs plugins/p-chat/tools/__tests__/queue.test.ts plugins/p-chat/tools/__tests__/split.test.ts
git commit -m "feat(p-chat): pure queue classification (exact-match boundary) and 4096 splitter"
```

---

### Task 9: API client, shell runner, send with Markdown fallback

**Files:**
- Create: `plugins/p-chat/tools/lib/api.mjs`, `plugins/p-chat/tools/lib/exec.mjs`, `plugins/p-chat/tools/lib/send.mjs`
- Test: `plugins/p-chat/tools/__tests__/send.test.ts`, `plugins/p-chat/tools/__tests__/exec.test.ts`

**Interfaces (produces):**
- `api.mjs`: `class ApiError extends Error { status?, description? }`; `makeApi({ apiBase, token, timeoutSec = 10, fetchFn = fetch }) -> { getMe(), getUpdates(offset?), sendMessage(payload) }` — each resolves to the parsed `result` or throws `ApiError`.
- `exec.mjs`: `runShell(cmd, { cwd, timeoutSec = 15 }) -> Promise<{ exit, timedOut, out, err, error? }>` (SIGKILL on timeout, 64 KB tail caps).
- `send.mjs`: `sendText({ api, cfg, chatId?, text, log? }) -> Promise<{ chatId, parts }>` — allowlist-refusal (ConfigError), split, Markdown first, plain-text retry on 400 parse errors (resolution B3).

- [ ] **Step 1: Write the failing tests**

```ts
// plugins/p-chat/tools/__tests__/exec.test.ts
import { describe, expect, it } from 'vitest';
import { runShell } from '../lib/exec.mjs';

describe('runShell', () => {
  it('captures stdout and exit code', async () => {
    const r = await runShell('node -e "console.log(\'ok-line\')"', {});
    expect(r.exit).toBe(0);
    expect(r.out).toContain('ok-line');
  });

  it('reports non-zero exits with stderr', async () => {
    const r = await runShell('node -e "console.error(\'bad\');process.exit(3)"', {});
    expect(r.exit).toBe(3);
    expect(r.err).toContain('bad');
  });

  it('kills a hung command at the timeout', async () => {
    const r = await runShell('node -e "setTimeout(()=>{},10000)"', { timeoutSec: 0.4 });
    expect(r.timedOut).toBe(true);
    expect(r.exit).toBeNull();
  }, 10000);
});
```

```ts
// plugins/p-chat/tools/__tests__/send.test.ts
import { describe, expect, it, vi } from 'vitest';
import { sendText } from '../lib/send.mjs';
import { ApiError } from '../lib/api.mjs';
import { ConfigError } from '../lib/config.mjs';

const cfg = { allowedChatIds: [111, 222], defaultChatId: 111 };
const okApi = () => ({ sendMessage: vi.fn(async (p: unknown) => ({ message_id: 1 })) });

describe('sendText', () => {
  it('sends one Markdown chunk to the default chat', async () => {
    const api = okApi();
    const r = await sendText({ api: api as never, cfg, text: 'hello' });
    expect(r).toEqual({ chatId: 111, parts: 1 });
    expect(api.sendMessage).toHaveBeenCalledWith({ chat_id: 111, text: 'hello', parse_mode: 'Markdown' });
  });

  it('splits long text into multiple sends', async () => {
    const api = okApi();
    const r = await sendText({ api: api as never, cfg, text: 'x'.repeat(5000) });
    expect(r.parts).toBe(2);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('falls back to plain text when Telegram rejects the Markdown (400 parse error)', async () => {
    const calls: unknown[] = [];
    const api = {
      sendMessage: vi.fn(async (p: { parse_mode?: string }) => {
        calls.push(p);
        if (p.parse_mode) throw new ApiError('bad', { status: 400, description: "Bad Request: can't parse entities: ..." });
        return { message_id: 1 };
      }),
    };
    const r = await sendText({ api: api as never, cfg, text: 'unbalanced _markdown' });
    expect(r.parts).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect((calls[1] as { parse_mode?: string }).parse_mode).toBeUndefined();
  });

  it('re-throws non-parse API errors', async () => {
    const api = { sendMessage: vi.fn(async () => { throw new ApiError('down', { status: 502 }); }) };
    await expect(sendText({ api: api as never, cfg, text: 'x' })).rejects.toThrow(ApiError);
  });

  it('REFUSES a --to target outside the allowlist', async () => {
    const api = okApi();
    await expect(sendText({ api: api as never, cfg, chatId: 999, text: 'leak' })).rejects.toThrow(ConfigError);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses empty text and a missing target', async () => {
    await expect(sendText({ api: okApi() as never, cfg, text: '' })).rejects.toThrow(ConfigError);
    await expect(sendText({ api: okApi() as never, cfg: { allowedChatIds: [1] }, text: 'x' })).rejects.toThrow(ConfigError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run plugins/p-chat`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement `api.mjs`**

```js
// plugins/p-chat/tools/lib/api.mjs
export class ApiError extends Error {
  constructor(message, { status, description } = {}) {
    super(message);
    this.status = status;
    this.description = description;
  }
}

// Minimal Bot API client: plain fetch + JSON, zero deps. Each call resolves to the
// parsed `result` or throws ApiError (network, timeout, non-2xx, ok:false). apiBase
// is configurable — the test seam for the in-test mock server (resolution B5). The
// token rides in the URL path per Bot API convention; it is never logged.
export function makeApi({ apiBase, token, timeoutSec = 10, fetchFn = fetch }) {
  const call = async (method, payload) => {
    const url = `${String(apiBase).replace(/\/+$/, '')}/bot${token}/${method}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutSec * 1000);
    let res, body;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: ctl.signal,
      });
      body = await res.json().catch(() => null);
    } catch (e) {
      throw new ApiError(`telegram ${method} failed: ${e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
    if (!body || body.ok !== true) {
      throw new ApiError(`telegram ${method} error: ${body?.description ?? `HTTP ${res.status}`}`, { status: res.status, description: body?.description });
    }
    return body.result;
  };
  return {
    getMe: () => call('getMe'),
    // timeout: 0 -> a PEEK, not a long poll: Telegram re-serves updates until a later
    // offset confirms them (and holds them ~24h).
    getUpdates: (offset) => call('getUpdates', { ...(offset != null ? { offset } : {}), timeout: 0 }),
    sendMessage: (payload) => call('sendMessage', payload),
  };
}
```

- [ ] **Step 4: Implement `exec.mjs`**

```js
// plugins/p-chat/tools/lib/exec.mjs
import { spawn } from 'node:child_process';

// Run a configured scripted command — a shell line from .pchat.json (owner-authored;
// NEVER built from message text). Bounded: timeout -> SIGKILL, output tail-capped.
export function runShell(cmd, { cwd, timeoutSec = 15, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, [], { cwd, shell: true, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const CAP = 64 * 1024;
    let out = '', err = '';
    child.stdout?.on('data', (c) => { out = (out + c).slice(-CAP); });
    child.stderr?.on('data', (c) => { err = (err + c).slice(-CAP); });
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    let timedOut = false;
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutSec * 1000);
    child.on('exit', (code) => finish({ exit: timedOut ? null : code, timedOut, out, err }));
    child.on('error', (e) => finish({ exit: null, timedOut, error: e?.message ?? String(e), out, err }));
  });
}
```

- [ ] **Step 5: Implement `send.mjs`**

```js
// plugins/p-chat/tools/lib/send.mjs
import { splitMessage } from './split.mjs';
import { ApiError } from './api.mjs';
import { ConfigError, requireAllowlist } from './config.mjs';

// Deliver text to an allowlisted chat: split at the Telegram cap, try Markdown
// first, retry a rejected chunk as plain text (delivery beats formatting —
// resolution B3). Refuses any target outside allowedChatIds: a compromised or
// confused prompt cannot exfiltrate to an arbitrary chat.
export async function sendText({ api, cfg, chatId, text, log = () => {} }) {
  const allowed = requireAllowlist(cfg);
  const target = chatId ?? cfg.defaultChatId;
  if (target == null) throw new ConfigError('no chat id: pass --to or set defaultChatId in .pchat.json');
  if (!allowed.includes(target)) throw new ConfigError(`chat ${target} is not in allowedChatIds — refusing to send`);
  const chunks = splitMessage(text);
  if (chunks.length === 0) throw new ConfigError('nothing to send: empty text');
  if (chunks.length > 1) log({ event: 'split', parts: chunks.length });
  for (const chunk of chunks) {
    try {
      await api.sendMessage({ chat_id: target, text: chunk, parse_mode: 'Markdown' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 400 && /parse/i.test(e.description ?? '')) {
        log({ event: 'markdown-fallback' });
        await api.sendMessage({ chat_id: target, text: chunk });
      } else {
        throw e;
      }
    }
  }
  return { chatId: target, parts: chunks.length };
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run plugins/p-chat`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/p-chat/tools/lib/api.mjs plugins/p-chat/tools/lib/exec.mjs plugins/p-chat/tools/lib/send.mjs plugins/p-chat/tools/__tests__/send.test.ts plugins/p-chat/tools/__tests__/exec.test.ts
git commit -m "feat(p-chat): Bot API client, bounded shell runner, send with Markdown fallback"
```

---

### Task 10: core orchestration — guard scan, pending, init

**Files:**
- Create: `plugins/p-chat/tools/lib/core.mjs`
- Test: `plugins/p-chat/tools/__tests__/core.test.ts` (injected fakes; the real-HTTP path is Task 11's e2e)

**Interfaces:**
- Consumes: `classifyUpdate`/`pendingFreeTexts` (Task 8), `runShell` (Task 9), `sendText` (Task 9), `readOffset`/`writeOffset`/`appendLocalLog` (Task 7), `requireAllowlist`/`ConfigError` (Task 7), an `api` object (Task 9 shape).
- Produces:
  - `guardScan({ root, cfg, api, now?, deps? }) -> Promise<{ result: 'work'|'quiet', confirmed }>` — throws ConfigError/ApiError when broken.
  - `listPending({ root, cfg, api, now? }) -> Promise<Array<{ updateId, chatId, text, date }>>`.
  - `initDiscover({ api, chatId? }) -> Promise<{ me, chatId, confirmed }>` — getMe smoke test + chat-id discovery + cursor baseline (resolution B2).

- [ ] **Step 1: Write the failing test**

```ts
// plugins/p-chat/tools/__tests__/core.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardScan, initDiscover, listPending } from '../lib/core.mjs';
import { readOffset, writeOffset } from '../lib/state.mjs';
import { ConfigError } from '../lib/config.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pchat-core-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const cfg = { allowedChatIds: [111], defaultChatId: 111, commands: { '/status': 'run-status-tool' }, commandTimeoutSec: 15 };
let id = 100;
const msg = (chatId: number, text?: string) =>
  ({ update_id: ++id, message: { message_id: id, date: 1, chat: { id: chatId }, ...(text !== undefined ? { text } : {}) } });

const fakes = (overrides: Record<string, unknown> = {}) => ({
  runShell: vi.fn(async () => ({ exit: 0, timedOut: false, out: 'all green', err: '' })),
  sendText: vi.fn(async () => ({ chatId: 111, parts: 1 })),
  appendLocalLog: vi.fn(),
  ...overrides,
});

describe('guardScan', () => {
  it('empty queue -> quiet', async () => {
    const api = { getUpdates: vi.fn(async () => []) };
    const r = await guardScan({ root, cfg, api: api as never, deps: fakes() });
    expect(r.result).toBe('quiet');
  });

  it('free text from an allowed chat -> work, message stays UNCONFIRMED', async () => {
    const q = msg(111, 'how is it going?');
    const api = { getUpdates: vi.fn(async () => [q]) };
    const r = await guardScan({ root, cfg, api: api as never, deps: fakes() });
    expect(r.result).toBe('work');
    expect(readOffset(root).confirmed).toBe(0); // NOT past the question
  });

  it('a scripted command runs, its output is sent back, cursor advances, then quiet', async () => {
    const c = msg(111, '/status');
    const api = { getUpdates: vi.fn(async () => [c]) };
    const d = fakes();
    const r = await guardScan({ root, cfg, api: api as never, deps: d });
    expect(r.result).toBe('quiet');
    expect(d.runShell).toHaveBeenCalledWith('run-status-tool', expect.objectContaining({ timeoutSec: 15 }));
    expect(d.sendText).toHaveBeenCalledOnce();
    expect((d.sendText as any).mock.calls[0][0].text).toContain('all green');
    expect(readOffset(root).confirmed).toBe(c.update_id);
  });

  it('a failing command still answers (exit marker) and advances', async () => {
    const c = msg(111, '/status');
    const api = { getUpdates: vi.fn(async () => [c]) };
    const d = fakes({ runShell: vi.fn(async () => ({ exit: 3, timedOut: false, out: '', err: 'db down' })) });
    await guardScan({ root, cfg, api: api as never, deps: d });
    expect((d.sendText as any).mock.calls[0][0].text).toMatch(/exit 3/);
    expect(readOffset(root).confirmed).toBe(c.update_id);
  });

  it('processes strictly in order and STOPS at the first free text: [other, /status, q, /jobs]', async () => {
    const spam = msg(999, 'spam');
    const c = msg(111, '/status');
    const q = msg(111, 'question');
    const c2 = msg(111, '/status');
    const api = { getUpdates: vi.fn(async () => [spam, c, q, c2]) };
    const d = fakes();
    const r = await guardScan({ root, cfg, api: api as never, deps: d });
    expect(r.result).toBe('work');
    expect(d.runShell).toHaveBeenCalledTimes(1);           // only the command BEFORE the question
    expect(readOffset(root).confirmed).toBe(c.update_id);  // cursor never jumps the question
  });

  it('at-least-once for commands: a send failure leaves the command unconfirmed', async () => {
    const c = msg(111, '/status');
    const api = { getUpdates: vi.fn(async () => [c]) };
    const d = fakes({ sendText: vi.fn(async () => { throw new Error('network'); }) });
    await expect(guardScan({ root, cfg, api: api as never, deps: d })).rejects.toThrow();
    expect(readOffset(root).confirmed).toBe(0); // re-served and re-run next pass
  });

  it('an empty allowlist is a hard error (exit 2 path), never quiet', async () => {
    const api = { getUpdates: vi.fn(async () => []) };
    await expect(guardScan({ root, cfg: { ...cfg, allowedChatIds: [] }, api: api as never, deps: fakes() })).rejects.toThrow(ConfigError);
  });
});

describe('listPending', () => {
  it('returns the free-text prefix and updates lastPollAt without moving the cursor', async () => {
    writeOffset(root, { confirmed: 50, lastPollAt: null });
    const q = msg(111, 'q1');
    const api = { getUpdates: vi.fn(async () => [q, msg(111, '/status'), msg(111, 'q2')]) };
    const got = await listPending({ root, cfg, api: api as never });
    expect(got.map((p: { text: string }) => p.text)).toEqual(['q1']);
    expect(api.getUpdates).toHaveBeenCalledWith(51);
    expect(readOffset(root).confirmed).toBe(50);
    expect(readOffset(root).lastPollAt).not.toBeNull();
  });
});

describe('initDiscover', () => {
  it('discovers the chat id from the newest message and baselines the cursor (B2)', async () => {
    const a = msg(111, 'hi');
    const b = msg(222, 'yo');
    const api = { getMe: vi.fn(async () => ({ username: 'bot' })), getUpdates: vi.fn(async () => [a, b]) };
    const r = await initDiscover({ api: api as never });
    expect(r.chatId).toBe(222);
    expect(r.confirmed).toBe(b.update_id);
  });

  it('respects an explicit chatId but still baselines', async () => {
    const a = msg(111, 'hi');
    const api = { getMe: vi.fn(async () => ({ username: 'bot' })), getUpdates: vi.fn(async () => [a]) };
    const r = await initDiscover({ api: api as never, chatId: 555 });
    expect(r.chatId).toBe(555);
    expect(r.confirmed).toBe(a.update_id);
  });

  it('throws when no chatId given and no updates pending', async () => {
    const api = { getMe: vi.fn(async () => ({ username: 'bot' })), getUpdates: vi.fn(async () => []) };
    await expect(initDiscover({ api: api as never })).rejects.toThrow(/message first/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/p-chat/tools/__tests__/core.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `core.mjs`**

```js
// plugins/p-chat/tools/lib/core.mjs
import { ConfigError, requireAllowlist } from './config.mjs';
import { classifyUpdate, pendingFreeTexts } from './queue.mjs';
import { readOffset, writeOffset, appendLocalLog as realAppendLocalLog } from './state.mjs';
import { runShell as realRunShell } from './exec.mjs';
import { sendText as realSendText } from './send.mjs';

// The p-shed guard body. Peek the queue (getUpdates with offset = confirmed+1 is a
// peek — Telegram re-serves until a later offset confirms), serve scripted commands,
// decide launch:
//   { result: 'work' }  -> a free-text question is pending (CLI exits 0 -> Claude runs)
//   { result: 'quiet' } -> nothing to do (CLI exits 75)
// Throws ConfigError/ApiError when broken (CLI exits 2 -> p-shed guard-error -> breaker).
//
// Updates are processed STRICTLY IN QUEUE ORDER with a single cursor, and the scan
// STOPS at the first free-text message from an allowed chat: Telegram confirms
// everything below the offset, so the cursor must never jump an unanswered question.
// The cursor is persisted after EACH processed update — a crash mid-scan never
// re-answers what was already confirmed (commands are at-least-once: answered, THEN
// confirmed).
export async function guardScan({ root, cfg, api, now = Date.now, deps = {} }) {
  const d = { runShell: realRunShell, sendText: realSendText, appendLocalLog: realAppendLocalLog, ...deps };
  requireAllowlist(cfg);
  const offset = readOffset(root);
  const updates = await api.getUpdates(offset.confirmed + 1);
  let confirmed = offset.confirmed;
  let work = false;
  for (const u of updates) {
    const c = classifyUpdate(u, cfg);
    if (c.kind === 'free') { work = true; break; } // stays unconfirmed for the responder
    if (c.kind === 'command') {
      // Scripted answers work even when Claude is usage-limited or broken — that is
      // the whole point of handling them here, without a launch.
      const r = await d.runShell(cfg.commands[c.command], { cwd: root, timeoutSec: cfg.commandTimeoutSec });
      await d.sendText({ api, cfg, chatId: c.chatId, text: commandReply(c.command, r), log: (rec) => d.appendLocalLog(root, { ts: now(), ...rec }) });
      d.appendLocalLog(root, { ts: now(), event: 'command', command: c.command, exit: r.exit, timedOut: r.timedOut });
    } else {
      d.appendLocalLog(root, { ts: now(), event: 'skipped-update', updateId: c.updateId, chatId: c.chatId ?? null });
    }
    confirmed = c.updateId;
    writeOffset(root, { confirmed, lastPollAt: now() });
  }
  writeOffset(root, { confirmed, lastPollAt: now() });
  return { result: work ? 'work' : 'quiet', confirmed };
}

// Command reply: output tail, capped well under one Telegram message, with an
// explicit error marker so a failing status tool is visible from the phone.
function commandReply(command, r) {
  const text = [r.out, r.err].filter(Boolean).join('\n').trim();
  const capped = text.length > 3500 ? `…${text.slice(-3500)}` : text;
  if (r.timedOut) return `${command}: timed out`;
  if (r.exit !== 0) return `${command}: exit ${r.exit}${capped ? `\n${capped}` : ''}`;
  return capped || `${command}: ok (no output)`;
}

// The responder's read view (see queue.mjs for the stop-before-first-command rule).
// Never moves the confirmed cursor — only `ack` does that.
export async function listPending({ root, cfg, api, now = Date.now }) {
  requireAllowlist(cfg);
  const offset = readOffset(root);
  const updates = await api.getUpdates(offset.confirmed + 1);
  writeOffset(root, { ...offset, lastPollAt: now() });
  return pendingFreeTexts(updates, cfg);
}

// init helper: getMe smoke test, chat-id discovery from the newest pending message
// (--chat-id optional — resolution B2), and cursor baseline to the newest update so
// stale history (Telegram holds ~24h) is never replayed.
export async function initDiscover({ api, chatId }) {
  const me = await api.getMe();
  const updates = await api.getUpdates();
  let confirmed = 0;
  for (const u of updates) confirmed = Math.max(confirmed, u.update_id);
  let discovered = chatId;
  if (discovered == null) {
    const withChat = updates.filter((u) => u.message?.chat?.id != null);
    if (withChat.length === 0) {
      throw new ConfigError('no --chat-id given and no pending updates — send the bot any message first, then re-run init');
    }
    discovered = withChat[withChat.length - 1].message.chat.id;
  }
  return { me, chatId: discovered, confirmed };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run plugins/p-chat`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-chat/tools/lib/core.mjs plugins/p-chat/tools/__tests__/core.test.ts
git commit -m "feat(p-chat): guard scan (in-order, stop-at-free-text), pending view, init discovery"
```

---

### Task 11: CLI + mock Bot API e2e

**Files:**
- Create: `plugins/p-chat/tools/pchat.mjs`
- Create: `plugins/p-chat/tools/__tests__/mock-api.ts` (helper, not a test)
- Test: `plugins/p-chat/tools/__tests__/cli-e2e.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: the `pchat` CLI — commands `init | guard | pending | ack | send | reset | status`; exits 0 ok / 1 internal / 2 ConfigError|ApiError / **75 quiet (guard only)**. `init` accepts `--token-file <p> [--chat-id <id>] [--api-base <url>]`.

- [ ] **Step 1: Write the mock server helper**

```ts
// plugins/p-chat/tools/__tests__/mock-api.ts
import { createServer } from 'node:http';

export interface MockApi {
  url: string;
  state: {
    updates: any[];
    sent: any[];
    rejectParseMode: boolean; // 400 "can't parse entities" for any parse_mode send
  };
  seed(update: any): void;
  close(): Promise<void>;
}

let nextId = 1;
export const msg = (chatId: number, text?: string, extra: Record<string, unknown> = {}) =>
  ({ update_id: nextId++, message: { message_id: nextId, date: 1_750_000_000, chat: { id: chatId }, ...(text !== undefined ? { text } : {}), ...extra } });

// Faithful-enough Bot API: getUpdates(offset) CONFIRMS (drops) updates below the
// offset and re-serves the rest — the peek/confirm semantics the guard exploits.
export function startMockApi(token: string): Promise<MockApi> {
  const state = { updates: [] as any[], sent: [] as any[], rejectParseMode: false };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (obj: unknown, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const m = new RegExp(`^/bot${token}/(\\w+)$`).exec(req.url ?? '');
      if (!m) return send({ ok: false, description: 'Unauthorized' }, 401);
      const payload = body ? JSON.parse(body) : {};
      if (m[1] === 'getMe') return send({ ok: true, result: { id: 42, is_bot: true, username: 'mock_bot' } });
      if (m[1] === 'getUpdates') {
        if (payload.offset != null) state.updates = state.updates.filter((u) => u.update_id >= payload.offset);
        return send({ ok: true, result: state.updates });
      }
      if (m[1] === 'sendMessage') {
        if (state.rejectParseMode && payload.parse_mode) {
          return send({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: unbalanced" }, 400);
        }
        state.sent.push(payload);
        return send({ ok: true, result: { message_id: state.sent.length } });
      }
      return send({ ok: false, description: 'unknown method' }, 404);
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolveP({
        url: `http://127.0.0.1:${port}`,
        state,
        seed: (u) => state.updates.push(u),
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
```

- [ ] **Step 2: Write the failing e2e test**

```ts
// plugins/p-chat/tools/__tests__/cli-e2e.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockApi, msg, type MockApi } from './mock-api';

const CLI = join(process.cwd(), 'plugins/p-chat/tools/pchat.mjs');
const TOKEN = 'TESTTOKEN123';

let root: string;
let mock: MockApi;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'pchat-e2e-'));
  mkdirSync(join(root, '.git')); // findRoot anchor
  mock = await startMockApi(TOKEN);
  writeFileSync(join(root, 'token.txt'), TOKEN + '\n', 'utf-8');
});
afterEach(async () => { await mock.close(); rmSync(root, { recursive: true, force: true }); });

// The /status command tool: a tiny node one-liner, cross-platform.
const STATUS_CMD = 'node -e "console.log(\'loop: all green\')"';

const writeCfg = (extra: Record<string, unknown> = {}) =>
  writeFileSync(join(root, '.pchat.json'), JSON.stringify({
    tokenFile: 'token.txt',
    allowedChatIds: [111],
    defaultChatId: 111,
    commands: { '/status': STATUS_CMD },
    sessionFile: '.pchat/session.md',
    apiBase: mock.url,
    ...extra,
  }), 'utf-8');

const run = (args: string[], input?: string) => {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf-8', cwd: root, ...(input !== undefined ? { input } : {}) });
    return { status: 0, stdout };
  } catch (e: any) {
    return { status: e.status as number, stdout: (e.stdout ?? '') as string };
  }
};
const confirmed = () => JSON.parse(readFileSync(join(root, '.pchat', 'offset.json'), 'utf-8')).confirmed;

describe('pchat cli e2e (mock Bot API)', () => {
  it('guard: empty queue -> 75; free text -> 0; ack -> 75 again (the full at-least-once loop)', () => {
    writeCfg();
    expect(run(['guard']).status).toBe(75);

    const q = msg(111, 'how is the loop?');
    mock.seed(q);
    expect(run(['guard']).status).toBe(0);

    // pending re-serves the SAME question until acked (kill-between-send-and-ack safety)
    const p1 = JSON.parse(run(['pending']).stdout).pending;
    expect(p1).toHaveLength(1);
    expect(p1[0]).toMatchObject({ updateId: q.update_id, text: 'how is the loop?' });
    const p2 = JSON.parse(run(['pending']).stdout).pending;
    expect(p2).toHaveLength(1); // re-served — not consumed by reading

    expect(run(['ack', '--until', String(q.update_id)]).status).toBe(0);
    expect(run(['guard']).status).toBe(75);
    expect(JSON.parse(run(['pending']).stdout).pending).toHaveLength(0);
  });

  it('guard answers a scripted /command without any Claude involvement and confirms it', () => {
    writeCfg();
    const c = msg(111, '/status');
    mock.seed(c);
    expect(run(['guard']).status).toBe(75); // command served, nothing left -> quiet
    expect(mock.state.sent).toHaveLength(1);
    expect(mock.state.sent[0].text).toContain('loop: all green');
    expect(confirmed()).toBe(c.update_id);
  });

  it('ordering e2e: [q1, /status, q2] — answer q1, ack, THEN the command runs, then q2', () => {
    writeCfg();
    const q1 = msg(111, 'first question');
    const c = msg(111, '/status');
    const q2 = msg(111, 'second question');
    mock.seed(q1); mock.seed(c); mock.seed(q2);

    expect(run(['guard']).status).toBe(0);
    expect(mock.state.sent).toHaveLength(0);          // command NOT executed yet (behind q1)
    const p = JSON.parse(run(['pending']).stdout).pending;
    expect(p.map((x: any) => x.text)).toEqual(['first question']); // B1: stops before /status

    run(['ack', '--until', String(q1.update_id)]);
    expect(run(['guard']).status).toBe(0);            // command answered, q2 now pending
    expect(mock.state.sent).toHaveLength(1);
    expect(confirmed()).toBe(c.update_id);            // cursor never jumped q2
    expect(JSON.parse(run(['pending']).stdout).pending.map((x: any) => x.text)).toEqual(['second question']);
  });

  it('non-allowlisted chats and stickers are skipped + logged, never answered', () => {
    writeCfg();
    mock.seed(msg(999, '/status'));
    mock.seed(msg(999, 'hello?'));
    mock.seed(msg(111, undefined, { sticker: {} }));
    expect(run(['guard']).status).toBe(75);
    expect(mock.state.sent).toHaveLength(0);
    const log = readFileSync(join(root, '.pchat', 'log.jsonl'), 'utf-8');
    expect(log.match(/skipped-update/g)!.length).toBe(3);
  });

  it('free text NEVER reaches the commands shell: "/status; echo pwned" is a question, not a command', () => {
    writeCfg();
    mock.seed(msg(111, '/status; echo pwned'));
    expect(run(['guard']).status).toBe(0); // free text -> work
    expect(mock.state.sent).toHaveLength(0);
  });

  it('negative self-tests: guard exits 2 (not 75) on empty allowlist and unreachable API', () => {
    writeCfg({ allowedChatIds: [] });
    expect(run(['guard']).status).toBe(2);
    writeCfg({ apiBase: 'http://127.0.0.1:1' }); // nothing listens there
    expect(run(['guard']).status).toBe(2);
  });

  it('ack refuses to move backwards', () => {
    writeCfg();
    const q = msg(111, 'q');
    mock.seed(q);
    run(['guard']);
    run(['ack', '--until', String(q.update_id)]);
    expect(run(['ack', '--until', String(q.update_id - 5)]).status).toBe(2);
  });

  it('send: argv text, stdin via "-", 4096 split, markdown fallback, allowlist refusal', () => {
    writeCfg();
    expect(run(['send', 'hello *world*']).status).toBe(0);
    expect(mock.state.sent.at(-1)).toMatchObject({ chat_id: 111, text: 'hello *world*', parse_mode: 'Markdown' });

    expect(run(['send', '-'], 'x'.repeat(5000)).status).toBe(0);
    expect(mock.state.sent).toHaveLength(3); // 1 + 2 chunks

    mock.state.rejectParseMode = true;
    expect(run(['send', 'broken _markdown']).status).toBe(0);
    expect(mock.state.sent.at(-1).parse_mode).toBeUndefined();
    mock.state.rejectParseMode = false;

    expect(run(['send', '--to', '999', 'leak']).status).toBe(2);
  });

  it('init discovers the chat id, baselines the cursor, writes config + gitignore; refuses a re-init', () => {
    const seed = msg(777, 'hi bot');
    mock.seed(seed);
    const r = run(['init', '--token-file', 'token.txt', '--api-base', mock.url]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ action: 'init', bot: 'mock_bot', chatId: 777 });
    const cfg = JSON.parse(readFileSync(join(root, '.pchat.json'), 'utf-8'));
    expect(cfg.allowedChatIds).toEqual([777]);
    expect(cfg.defaultChatId).toBe(777);
    expect(confirmed()).toBe(seed.update_id); // stale history never replayed
    expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toContain('.pchat/');
    expect(run(['init', '--token-file', 'token.txt', '--api-base', mock.url]).status).toBe(2);
  });

  it('init without --chat-id and without pending updates exits 2 with guidance', () => {
    const r = run(['init', '--token-file', 'token.txt', '--api-base', mock.url]);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error.message).toMatch(/message first/);
  });

  it('reset truncates the session; status reports offsets and session size', () => {
    writeCfg();
    mkdirSync(join(root, '.pchat'), { recursive: true });
    writeFileSync(join(root, '.pchat', 'session.md'), '## Q/A\n', 'utf-8');
    let st = JSON.parse(run(['status']).stdout);
    expect(st.session.bytes).toBeGreaterThan(0);
    expect(run(['reset']).status).toBe(0);
    st = JSON.parse(run(['status']).stdout);
    expect(st.session.bytes).toBe(0);
    expect(st).toHaveProperty('confirmed');
    expect(st).toHaveProperty('lastPollAt');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run plugins/p-chat/tools/__tests__/cli-e2e.test.ts`
Expected: FAIL — `pchat.mjs` doesn't exist.

- [ ] **Step 4: Implement the CLI**

```js
#!/usr/bin/env node
// plugins/p-chat/tools/pchat.mjs — dumb Telegram channel CLI. p-chat never
// schedules anything and never decides content: p-shed jobs own both. Exit codes:
// 0 ok, 1 internal, 2 config/validation/API (a BROKEN channel must be visible to
// p-shed's breaker), 75 = guard says "deliberately quiet".
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, findRoot, paths, readConfig, readToken, tokenPermsWarning } from './lib/config.mjs';
import { ApiError, makeApi } from './lib/api.mjs';
import { guardScan, initDiscover, listPending } from './lib/core.mjs';
import { ackUntil, appendLocalLog, ensureGitignore, readOffset, resetSession, sessionStatus, writeOffset } from './lib/state.mjs';
import { sendText } from './lib/send.mjs';

export const VERSION = '0.1.0';
const GUARD_QUIET = 75; // p-shed's quiet exit — EX_TEMPFAIL, deliberate by contract

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          out[key] = true;
        } else {
          out[key] = next;
          i++;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function emitJson(obj, exitCode = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(exitCode);
}

export function die(message, exitCode = 1) {
  process.stderr.write(message + '\n');
  process.exit(exitCode);
}

const KNOWN = ['init', 'guard', 'pending', 'ack', 'send', 'reset', 'status'];

async function main() {
  if (process.argv[2] === '--version') {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (!KNOWN.includes(command)) die(`unknown command: ${command}`, 1);
  const root = findRoot(process.cwd());

  try {
    if (command === 'init') {
      const tokenFile = args['token-file'];
      if (typeof tokenFile !== 'string' || !tokenFile) throw new ConfigError('init requires --token-file <path>');
      if (existsSync(paths(root).config)) throw new ConfigError('.pchat.json already exists — edit it directly, or delete it to re-init');
      const token = readToken({ tokenFile }, root);
      const apiBase = typeof args['api-base'] === 'string' ? args['api-base'] : 'https://api.telegram.org';
      const api = makeApi({ apiBase, token });
      const chatId = args['chat-id'] !== undefined ? Number(args['chat-id']) : undefined;
      const { me, chatId: discovered, confirmed } = await initDiscover({ api, chatId });
      const cfg = {
        tokenFile,
        allowedChatIds: [discovered],
        defaultChatId: discovered,
        commands: {},
        sessionFile: '.pchat/session.md',
        ...(apiBase !== 'https://api.telegram.org' ? { apiBase } : {}),
      };
      writeFileSync(paths(root).config, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
      writeOffset(root, { confirmed, lastPollAt: Date.now() });
      ensureGitignore(root);
      const warning = tokenPermsWarning(cfg, root);
      return emitJson({ action: 'init', bot: me.username, chatId: discovered, confirmed, ...(warning ? { warning } : {}) }, 0);
    }

    const cfg = readConfig(root);

    // Purely local commands — no token, no network.
    if (command === 'reset') {
      return emitJson({ action: 'reset', file: resetSession(root, cfg) }, 0);
    }
    if (command === 'status') {
      const offset = readOffset(root);
      return emitJson({
        action: 'status',
        confirmed: offset.confirmed,
        lastPollAt: offset.lastPollAt,
        session: sessionStatus(root, cfg),
        allowedChatIds: cfg.allowedChatIds ?? [],
        commands: Object.keys(cfg.commands ?? {}),
      }, 0);
    }
    if (command === 'ack') {
      if (args.until === undefined) throw new ConfigError('ack requires --until <update_id>');
      const next = ackUntil(root, Number(args.until));
      return emitJson({ action: 'ack', confirmed: next.confirmed }, 0);
    }

    const token = readToken(cfg, root);
    const api = makeApi({ apiBase: cfg.apiBase, token, timeoutSec: cfg.apiTimeoutSec });

    if (command === 'guard') {
      const r = await guardScan({ root, cfg, api });
      return emitJson({ action: 'guard', ...r }, r.result === 'quiet' ? GUARD_QUIET : 0);
    }
    if (command === 'pending') {
      return emitJson({ action: 'pending', pending: await listPending({ root, cfg, api }) }, 0);
    }
    if (command === 'send') {
      if (args._.length === 0) throw new ConfigError('send requires <text> or - (stdin)');
      const text = args._[0] === '-' ? readFileSync(0, 'utf-8') : args._.join(' ');
      const to = args.to !== undefined ? Number(args.to) : undefined;
      const r = await sendText({ api, cfg, chatId: to, text, log: (rec) => appendLocalLog(root, { ts: Date.now(), ...rec }) });
      return emitJson({ action: 'send', ...r }, 0);
    }
  } catch (e) {
    if (e instanceof ConfigError) return emitJson({ error: { code: 'config', message: e.message } }, 2);
    if (e instanceof ApiError) return emitJson({ error: { code: 'api', message: e.message } }, 2);
    return emitJson({ error: { code: 'internal', message: e?.message ?? String(e) } }, 1);
  }
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) main();
```

- [ ] **Step 5: Run the whole p-chat suite**

Run: `npx vitest run plugins/p-chat`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-chat/tools/pchat.mjs plugins/p-chat/tools/__tests__/mock-api.ts plugins/p-chat/tools/__tests__/cli-e2e.test.ts
git commit -m "feat(p-chat): pchat CLI with guard/pending/ack/send/init/reset/status + mock Bot API e2e"
```

---

### Task 12: packaging — skills, README, manifest, marketplace, root README

**Files:**
- Create: `plugins/p-chat/.claude-plugin/plugin.json`, `plugins/p-chat/README.md`, `plugins/p-chat/CLAUDE.md`, `plugins/p-chat/skills/init/SKILL.md`, `plugins/p-chat/skills/respond/SKILL.md`
- Modify: `.claude-plugin/marketplace.json`, `README.md` (root)
- Test: `plugins/p-chat/tools/__tests__/skills-structure.test.ts`

Once `plugin.json` lands, the root static suites (`plugin-manifests`, `skills`, `plugin-readme-coverage`, `marketplace`) start validating p-chat — so this task ships them all together.

- [ ] **Step 1: Write the failing structure test**

```ts
// plugins/p-chat/tools/__tests__/skills-structure.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const skillsDir = join(process.cwd(), 'plugins/p-chat/skills');
const read = (name: string) => readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf-8');

describe('p-chat skills', () => {
  it('ships init and respond', () => {
    for (const s of ['init', 'respond']) {
      expect(existsSync(join(skillsDir, s, 'SKILL.md'))).toBe(true);
    }
  });
  it('init walks the owner through BotFather + token file and NEVER accepts the token inline', () => {
    const init = read('init');
    expect(init).toContain('@BotFather');
    expect(init).toContain('--token-file');
    expect(init).toMatch(/never.*(paste|inline|chat)/i);
  });
  it('respond documents the at-least-once loop in order: pending -> answer -> send -> ack -> session', () => {
    const r = read('respond');
    const order = ['pending', 'send', 'ack --until', 'session'];
    let last = -1;
    for (const token of order) {
      const i = r.indexOf(token);
      expect(i, `missing or out of order: ${token}`).toBeGreaterThan(last);
      last = i;
    }
  });
  it('respond keeps answers phone-sized and grounded', () => {
    expect(read('respond')).toMatch(/short|phone/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run plugins/p-chat/tools/__tests__/skills-structure.test.ts`
Expected: FAIL — skills missing.

- [ ] **Step 3: Write `plugin.json`**

```json
{
  "name": "p-chat",
  "version": "0.1.0",
  "description": "Dumb Telegram channel for Claude Code loops: a p-shed guard + CLI (tool `pchat`: init, guard, pending, ack, send, reset, status). Scripted /commands are answered by the guard itself — no Claude launch, works even when Claude is down or usage-limited; a pending free-text question makes the guard request a launch, so Claude runs exactly as often as there are questions. Peek/confirm cursor over getUpdates gives at-least-once delivery; chat-id allowlist is fail-closed; message text is never interpolated into shell commands; the bot token lives only in a token file. Zero deps. Skills: init, respond.",
  "author": {
    "name": "Andrey Sukharev",
    "email": "andrey.sukharev@exinity.com"
  }
}
```

- [ ] **Step 4: Write `skills/init/SKILL.md`**

```markdown
---
name: init
description: Set up p-chat in the current repo — walk the owner through creating a Telegram bot and a token file, then run `pchat init` to verify the token, discover the chat id, and write `.pchat.json`. Use when the user says "init p-chat", "set up telegram chat", or "connect telegram".
argument-hint: (no arguments — the token file path is asked interactively)
allowed-tools: Bash(node:*) Read
---

# /p-chat:init

Set up the p-chat Telegram channel. One-shot; refuses if `.pchat.json` already exists.

## Step 0 — Refuse if already initialized
If `.pchat.json` exists in the repo root, stop: "p-chat already initialized here. Edit `.pchat.json` directly, or delete it to re-init."

## Step 1 — Owner creates the bot (you cannot do this for them)
Ask the owner to, on their phone or desktop Telegram:
1. Talk to `@BotFather` → `/newbot` → follow the prompts → receive the bot token.
   (If this deployment later goes to production, suggest creating TWO bots: a dev bot for now and a prod bot whose token only ever lives on the target machine.)
2. Put the token in a file themselves, e.g. `~/.config/p-chat/token`, and `chmod 600` it.
   The token must NEVER be pasted into this chat, a repo file, or a shell argument — it would persist in transcripts and history. Only ask for the *path* to the file.
3. Send the new bot any message (bots cannot message first — this seeds the chat id).

## Step 2 — Run init
Ask for the token file path, then:
    node "${CLAUDE_PLUGIN_ROOT}/tools/pchat.mjs" init --token-file <path>
- Exit 0: report the bot username and the discovered, allowlisted chat id.
- Exit 2 with "send the bot a message first": the owner skipped step 1.3 — ask them to send any message and re-run.
- Any `warning` about file permissions: relay it verbatim.

## Step 3 — Smoke test
    node "${CLAUDE_PLUGIN_ROOT}/tools/pchat.mjs" send "p-chat is up"
Confirm with the owner it arrived on their phone.

## Step 4 — Explain what's next
- Scripted commands: add entries to `commands` in `.pchat.json` (e.g. `"/status": "node <path>/pobserve.mjs status"`). The guard answers them without Claude.
- Free-text answering needs a p-shed job whose guard is `node <this plugin>/tools/pchat.mjs guard` and whose prompt invokes the `/p-chat:respond` skill. Recommend `guardTimeoutSec: 120` and `maxConsecutiveFailures: 10` for that job (short network outages must not trip the breaker).
```

- [ ] **Step 5: Write `skills/respond/SKILL.md`**

```markdown
---
name: respond
description: Answer pending free-text Telegram questions via the pchat CLI — read pending questions, answer each grounded in the repo, send, ack, and append to the session transcript. Use as the prompt of a p-shed chat-responder job, or when the user says "answer the chat" / "check telegram questions".
argument-hint: (no arguments)
allowed-tools: Bash(node:*) Read Grep Glob
---

# /p-chat:respond

Answer pending questions from the Telegram channel. Delivery is **at-least-once**:
`ack` runs only after the answer was sent, so a crash mid-run means the next run
answers again — a duplicate beats silence. Never `ack` what you have not answered.

## Step 1 — Read the queue
    node "${CLAUDE_PLUGIN_ROOT}/tools/pchat.mjs" pending
If `pending` is empty, stop — nothing to do.

## Step 2 — Load context
Read the session transcript at the `sessionFile` path from `.pchat.json`
(default `.pchat/session.md`) for conversation continuity.

## Step 3 — Answer each question IN ORDER
For each pending item (they arrive oldest first):
1. Compose the answer grounded in this repo's actual state (read files/status tools
   as needed — never guess). Keep it short: it is read on a phone screen.
2. Send it:
       node "${CLAUDE_PLUGIN_ROOT}/tools/pchat.mjs" send "<answer>"
   (or pipe long text: `... send -` with the answer on stdin).
3. Confirm it — ack up to and including THIS question's updateId:
       node "${CLAUDE_PLUGIN_ROOT}/tools/pchat.mjs" ack --until <updateId>
4. Append the Q/A pair to the session transcript file:

       ## <ISO date> — q<updateId>
       **Q:** <question>
       **A:** <answer>

## Notes
- Posting digests/reports needs none of this: any job can call `send` directly.
- If `send` fails, do NOT ack — the question stays queued and the next run retries.
```

- [ ] **Step 6: Write `plugins/p-chat/README.md`**

```markdown
# p-chat

A deliberately **dumb** Telegram channel for Claude Code loops: the mouth and ears,
never the brain. p-chat never schedules anything and never decides content — p-shed
jobs own both (p-shed = brains/schedule, p-observe = eyes, p-chat = mouth and ears).
Zero external deps: the Bot API is plain HTTPS + JSON on Node ≥ 18.

The core trick: `pchat guard` is a [p-shed job guard](../p-shed/README.md#job-guards).
On each tick it peeks the Telegram update queue (one cheap HTTPS call, no long poll,
no daemon):

- **Scripted commands** (`/status`, `/jobs`, …) are answered by the guard itself —
  no Claude launch, so they work even when Claude is down or usage-limited.
- **A free-text question** makes the guard exit `0` → p-shed launches the Claude
  responder (the `respond` skill). Claude runs exactly as often as there are
  questions, and never otherwise (exit `75` = quiet).
- **A broken channel** (network, bad config, empty allowlist) exits `2` → p-shed's
  breaker makes it visible.

## Skills

| Skill | Purpose |
|---|---|
| `/p-chat:init` | Guided setup: BotFather walkthrough, token file, `pchat init`, smoke send. |
| `/p-chat:respond` | The responder job's script: `pending` → answer → `send` → `ack` → session append. |

## Commands

Tool: `node tools/pchat.mjs <command>` (JSON output; exit `0` ok / `1` internal / `2` config-API error / `75` guard-quiet):

| Command | Purpose |
|---|---|
| `init --token-file <p> [--chat-id <id>] [--api-base <url>]` | Verify token (`getMe`), discover + allowlist the chat id (from the owner's seed message when `--chat-id` is omitted), baseline the cursor, write `.pchat.json`, gitignore `.pchat/`. |
| `guard` | The p-shed guard: peek queue, serve scripted commands, exit `0` question-pending / `75` quiet / `2` broken. |
| `pending` | List unacked free-text messages — the contiguous prefix up to (not including) the first scripted command, so an `ack` can never confirm an unexecuted command. |
| `ack --until <update_id>` | Confirm processing up to and including `<update_id>`. Monotonic — refuses to move backwards. |
| `send [--to <chatId>] <text \| ->` | Post a message (arg or stdin). Splits at 4096, tries Markdown, falls back to plain text if Telegram rejects the parse. Refuses targets outside `allowedChatIds`. |
| `reset` | Truncate the session transcript. |
| `status` | Offsets, last poll time, session size, allowlist, configured commands. |

## Config — `.pchat.json` (committed; contains no secrets)

    {
      "tokenFile": "~/.config/p-chat/token",
      "allowedChatIds": [123456789],
      "defaultChatId": 123456789,
      "commands": {
        "/status": "node <p-observe>/tools/pobserve.mjs status",
        "/jobs":   "node <p-shed>/tools/pshed.mjs status --human"
      },
      "sessionFile": ".pchat/session.md"
    }

Optional fields: `apiBase` (default `https://api.telegram.org`; also the test seam),
`commandTimeoutSec` (default 15), `apiTimeoutSec` (default 10).

Security model, in one table:

| Boundary | Rule |
|---|---|
| Token | Lives ONLY in `tokenFile` (chmod 600; checked on POSIX) — never argv, env dumps, repo files, or logs. |
| Inbound | `allowedChatIds` is fail-closed: empty allowlist = exit 2, never "respond to anyone". Non-allowlisted chats are logged locally and skipped — no reply, no error. |
| Commands | Message text either EXACTLY equals a `commands` key (after trim) or it is free text. No prefix match, no interpolation — text never reaches a shell. |
| Outbound | `send` refuses any `--to` outside `allowedChatIds` — a confused prompt cannot exfiltrate to an arbitrary chat. |

State lives in `.pchat/` (gitignored): `offset.json` (single `confirmed` cursor),
`session.md` (chat transcript; the responder appends, `reset` truncates),
`log.jsonl` (append-only local channel log: skipped updates, splits, errors).

## Mechanics: peek, confirm, at-least-once

`getUpdates` with `offset = confirmed + 1, timeout: 0` is a **peek** — Telegram
re-serves updates until a later offset confirms them (and holds them ~24 h). The
guard processes updates strictly in queue order with a single cursor and **stops at
the first free-text message**: everything from there on stays unconfirmed for the
responder. Telegram confirms *everything* below an offset, so the cursor never jumps
an unanswered question; a `/command` queued behind a question simply runs on the next
guard pass after the responder acks.

Delivery to the responder is **at-least-once**: `ack` runs only after the answer was
sent. A crash between `send` and `ack` yields a duplicate answer — duplicate beats
silence.

## Wiring the responder job (p-shed)

    - id: chat-responder
      schedule: "* * * * *"
      guard: "node <this plugin>/tools/pchat.mjs guard"
      guardTimeoutSec: 120
      maxConsecutiveFailures: 10
      prompt: "Invoke the p-chat respond skill: answer pending questions."

`guardTimeoutSec: 120` gives scripted commands room; `maxConsecutiveFailures: 10`
keeps a few minutes of network outage from tripping the breaker (each outage minute
is one guard error). While the responder is running, p-shed's live-pid gate skips
the tick entirely — the guard and the responder never race over the cursor. A
guard-only `session-clean` job (see the p-shed README) can truncate the session
nightly via `pchat reset`.

## Known limitations

- One deployment per repo root (one `.pchat.json`, one cursor). One bot per repo.
- `log.jsonl` is append-only (no rotation) — spam from non-allowlisted chats grows
  it; it is gitignored and safe to delete.
- Group chats: commands sent as `/status@yourbot` do not exact-match a `/status`
  key — the design targets a 1:1 chat with the owner.
- `pshed pause` silences the chat too (the guard never runs while p-shed is paused);
  keep an independent alarm path for that case.
```

- [ ] **Step 7: Write `plugins/p-chat/CLAUDE.md`**

```markdown
# p-chat — contributor guide

Deliberately dumb channel plugin. Key decisions (see
`docs/superpowers/specs/2026-07-29-pshed-guard-and-p-chat-design.md` in the repo root
for the full design + review resolutions):

- **Guard exit contract: 0 = question pending, 75 = quiet, 2 = broken.** 75 is
  EX_TEMPFAIL — deliberate by construction so a crash can never read as quiet. A
  network/API/config failure MUST be exit 2 (fail-closed, visible to p-shed's
  breaker), never 75.
- **Single cursor, strict queue order, stop at first free text.** Telegram's
  `getUpdates` confirms everything below the offset, so the cursor never jumps an
  unanswered question; a /command behind a question waits for the responder's ack.
  `pending` returns only the contiguous free-text PREFIX (stops before the first
  command) — otherwise a batch-ack would confirm an unexecuted command.
- **At-least-once, both for commands and questions**: answer first, confirm after.
  Crash between send and ack → duplicate answer. Duplicate beats silence.
- **Injection boundary in `queue.mjs`**: message text either exactly equals a
  `commands` key (after trim, own-property check) or it is free text. Never
  prefix-match, never interpolate text into a shell line.
- **Fail-closed allowlist** (`requireAllowlist`): empty = ConfigError = exit 2.
  `send` refuses targets outside the allowlist (anti-exfiltration).
- **Token discipline**: token only in `tokenFile`; it rides in the Bot API URL but
  is never logged (log records carry no URLs).
- **`apiBase` is the test seam** — the e2e suite runs the real CLI against an
  in-test mock Bot API (`__tests__/mock-api.ts`) that faithfully implements
  peek/confirm. No real network in tests.
- **Markdown fallback**: sendMessage retries a chunk without `parse_mode` on a 400
  parse error — delivery beats formatting.
- Zero deps; Node ≥ 18 global `fetch`.
```

- [ ] **Step 8: Add the marketplace entry**

In `.claude-plugin/marketplace.json`, append to `plugins`:

```json
    {
      "name": "p-chat",
      "source": "./plugins/p-chat",
      "description": "Dumb Telegram channel for Claude Code loops: a p-shed job guard + pchat CLI (init, guard, pending, ack, send, reset, status). Scripted /commands answered without Claude; free-text questions trigger a Claude responder launch via p-shed. Zero deps. Skills: init, respond."
    }
```

- [ ] **Step 9: Update the root `README.md`**

- Line 14: extend the name list with `p-chat`: `` `<plugin-name>` is one of `p-wiki`, `p-flow`, `p-tasks`, `p-statusline`, `p-graph`, `p-shed`, `p-observe`, `p-chat` (see below). ``
- After the `p-observe` section, add:

```markdown
### [`p-chat`](./plugins/p-chat/)

A deliberately dumb Telegram channel with a bundled `pchat` CLI — the mouth and ears of a Claude Code loop, never the brain. Runs as a p-shed job guard: scripted `/commands` are answered directly (no Claude launch, works even when Claude is usage-limited); a pending free-text question makes the guard request a Claude responder launch. Fail-closed chat allowlist, at-least-once delivery, zero dependencies.

Skills: `init`, `respond`.
```

- In the repository-layout tree, add under `p-shed`:

```
│   ├── p-chat/              ← dumb Telegram channel (pchat CLI + p-shed guard)
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── README.md
│   │   ├── skills/
│   │   └── tools/           ← the pchat CLI (config, queue, api, send, core)
```

- [ ] **Step 10: Run the FULL suite (root static tests now validate p-chat)**

Run: `npx vitest run`
Expected: PASS — marketplace, manifests, skills, README-coverage, and all plugin suites green.

- [ ] **Step 11: Commit**

```bash
git add plugins/p-chat/.claude-plugin/plugin.json plugins/p-chat/README.md plugins/p-chat/CLAUDE.md plugins/p-chat/skills .claude-plugin/marketplace.json README.md plugins/p-chat/tools/__tests__/skills-structure.test.ts
git commit -m "feat(p-chat): package the plugin — skills (init, respond), README, manifest, marketplace entry"
```

---

### Task 13: acceptance sweep

- [ ] **Step 1: Full test run**

Run: `npx vitest run`
Expected: PASS, zero failures. Existing p-shed test files unmodified: `git diff --stat main -- plugins/p-shed/tools/__tests__/tick.test.ts plugins/p-shed/tools/__tests__/jobs.test.ts plugins/p-shed/tools/__tests__/status.test.ts plugins/p-shed/tools/__tests__/cli-e2e.test.ts` shows no changes. (If this plan is executed directly on `main`, compare against the pre-plan commit instead.)

- [ ] **Step 2: Negative self-test spot check (acceptance §5.4 — "demonstrably capable of failing")**

Temporarily flip the guard contract in `plugins/p-shed/tools/lib/guard.mjs` — change `r.exit === GUARD_QUIET_EXIT ? 'quiet'` to `r.exit !== 0 ? 'quiet'` — run `npx vitest run plugins/p-shed/tools/__tests__/guard.test.ts`, confirm the "exit 1 as error, NOT quiet" test FAILS, then revert the change (`git checkout -- plugins/p-shed/tools/lib/guard.mjs`). Do the same for p-chat: in `plugins/p-chat/tools/lib/queue.mjs` change the exact-match to `trimmed.startsWith(...)`-style prefix match is not directly expressible — instead change `cfg.commands ?? {}` lookup to also match when `trimmed.split(' ')[0]` is a key; confirm `queue.test.ts` ("no prefix match") fails; revert.

- [ ] **Step 3: Spec acceptance checklist**

Walk `docs/superpowers/specs/2026-07-29-pshed-guard-and-p-chat-design.md` §5:
1. ✅ new suites green, existing untouched (Step 1).
2. ✅ guarded demo behavior — covered end-to-end by `cli-guard-e2e.test.ts` (quiet/no-launch/no-noise, `guarded: true`, breaker trip visible in state and `status`).
3. ✅ p-chat e2e vs mock incl. at-least-once replay (`cli-e2e.test.ts`).
4. ✅ negative self-tests demonstrated (Step 2).
5. ✅ READMEs + marketplace updated (Tasks 6, 12). Release notes/versions: deferred to an explicit release request per repo rule.
6. ⏳ live smoke checklist (§2.7) — requires the owner and a real bot; report as the remaining manual step.

- [ ] **Step 4: Report**

Summarize to the user: what shipped, test counts, the deferred release step, and the §2.7 live smoke checklist as the only remaining manual item.
