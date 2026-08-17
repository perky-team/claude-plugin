# p-shed HTML report — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `pshed report [--out <path>]`, one read-only command that renders p-shed's own state and its own run logs into a single self-contained HTML page.

**Architecture:** Four pure functions and one thin command. `readLogRecords` reads the JSONL logs, `aggregate` folds them into totals, `computeNext` works out when each job runs next, `barsByDay` draws one SVG, and `renderHtml` assembles the page. The command wires them to the existing `collectStatus` and writes the result atomically. Nothing listens on a port; delivery is the operator's own static file server.

**Tech Stack:** Node ≥ 22.5, ES modules, zero external dependencies, vitest for tests.

**Spec:** [`docs/superpowers/specs/2026-08-14-pshed-report-html-design.md`](../specs/2026-08-14-pshed-report-html-design.md)

## Global Constraints

- **Zero external dependencies.** Nothing under `tools/` may import a bare package. Node built-ins only. The only vendored dependency is js-yaml and this feature does not touch it.
- **Never call `process.exit()`.** Set `process.exitCode` and `return`. Every call site must `return emitJson(...)` / `return die(...)`. A pipe write is asynchronous in Node; a hard exit truncates it. This page is the largest output the CLI produces, so it is the most exposed command in the tool.
- **All source, comments, commit messages, and page text are in English.**
- **The page loads nothing from the network and contains no JavaScript.** No `<script>`, no `http://`, no `https://`, no external fonts or images.
- **The command writes nothing under `.pshed/`.** No state file, no log row. Running it must never disturb the tick.
- **Every value that came from outside gets escaped** before it reaches the page: job ids, pause reasons, breaker reasons, guard reasons, and the raw output tail.
- **Test files are TypeScript (`.test.ts`) importing the `.mjs` modules**, using vitest with `mkdtempSync` temp roots, matching the existing files in `plugins/p-shed/tools/__tests__/`.
- **The suite must be run under WSL on Node 24+** before any of this is called verified. See `.claude/CLAUDE.md`. A Windows-only run cannot see the pipe-truncation failure at all.

All paths below are relative to the repository root.

---

### Task 1: Read log records

**Files:**
- Modify: `plugins/p-shed/tools/lib/logs.mjs`
- Test: `plugins/p-shed/tools/__tests__/logs.test.ts`

**Interfaces:**
- Consumes: `paths(root)` from `./io.mjs` (already imported in this file).
- Produces: `readLogRecords(root, sinceMs) -> { records: object[], skippedLines: number }`. `records` is sorted oldest first and contains only records whose `ts` is a number at or after `sinceMs`.

- [ ] **Step 1: Write the failing test**

Add to `plugins/p-shed/tools/__tests__/logs.test.ts`. Extend the existing import from `../lib/logs.mjs` to include `readLogRecords`:

```ts
describe('readLogRecords', () => {
  const write = (name: string, lines: string[]) => {
    const dir = paths(root).logsDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), lines.join('\n') + '\n');
  };

  it('returns an empty result when there is no log directory', () => {
    expect(readLogRecords(root, 0)).toEqual({ records: [], skippedLines: 0 });
  });

  it('reads every dated file and sorts records oldest first', () => {
    write('2026-07-15.jsonl', [JSON.stringify({ ts: 200, job: 'b' })]);
    write('2026-07-16.jsonl', [JSON.stringify({ ts: 100, job: 'a' })]);
    const { records } = readLogRecords(root, 0);
    expect(records.map((r) => r.job)).toEqual(['a', 'b']);
  });

  it('drops records older than sinceMs without counting them as skipped', () => {
    write('2026-07-16.jsonl', [
      JSON.stringify({ ts: 100, job: 'old' }),
      JSON.stringify({ ts: 300, job: 'new' }),
    ]);
    const { records, skippedLines } = readLogRecords(root, 200);
    expect(records.map((r) => r.job)).toEqual(['new']);
    expect(skippedLines).toBe(0);
  });

  it('skips and counts a line that does not parse', () => {
    write('2026-07-16.jsonl', [JSON.stringify({ ts: 100, job: 'a' }), '{"ts":1,']);
    const { records, skippedLines } = readLogRecords(root, 0);
    expect(records).toHaveLength(1);
    expect(skippedLines).toBe(1);
  });

  it('skips and counts a record with no numeric ts', () => {
    write('2026-07-16.jsonl', [JSON.stringify({ job: 'a' })]);
    expect(readLogRecords(root, 0)).toEqual({ records: [], skippedLines: 1 });
  });

  it('ignores files that are not dated jsonl', () => {
    write('2026-07-16.jsonl', [JSON.stringify({ ts: 100, job: 'a' })]);
    writeFileSync(join(paths(root).logsDir, 'cron.log'), 'noise\n');
    expect(readLogRecords(root, 0).records).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/logs.test.ts`
Expected: FAIL — `readLogRecords is not a function`.

- [ ] **Step 3: Write the implementation**

In `plugins/p-shed/tools/lib/logs.mjs`, extend the first import to include `readFileSync`:

```js
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
```

Then append:

```js
// Every dated log file in the directory, parsed line by line. The tick appends to these
// files while this reads them, so a torn final line is expected and must never be fatal:
// an unparseable line is skipped and counted, and the count is shown on the page.
//
// Reading EVERY file and filtering by `ts` is deliberate. File names are UTC dates
// (`dateStr` above) while schedules fire in local time, so picking files by name would
// silently drop the local end of the window on any machine that is not on UTC.
export function readLogRecords(root, sinceMs) {
  const dir = paths(root).logsDir;
  if (!existsSync(dir)) return { records: [], skippedLines: 0 };
  const records = [];
  let skippedLines = 0;
  let names;
  try { names = readdirSync(dir); } catch { return { records: [], skippedLines: 0 }; }
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    let text;
    try { text = readFileSync(join(dir, name), 'utf-8'); }
    catch { skippedLines++; continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { skippedLines++; continue; }
      if (!rec || typeof rec.ts !== 'number') { skippedLines++; continue; }
      if (rec.ts < sinceMs) continue;   // outside the window is not a defect
      records.push(rec);
    }
  }
  records.sort((a, b) => a.ts - b.ts);
  return { records, skippedLines };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run plugins/p-shed/tools/__tests__/logs.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/logs.mjs plugins/p-shed/tools/__tests__/logs.test.ts
git commit -m "feat(p-shed): read run-log records back out of the dated JSONL files"
```

---

### Task 2: Aggregate the window

**Files:**
- Create: `plugins/p-shed/tools/lib/report.mjs`
- Test: `plugins/p-shed/tools/__tests__/report.test.ts`

**Interfaces:**
- Consumes: records shaped like the run rows `readLogRecords` returns.
- Produces: `windowStart(now, windowDays = 7) -> number` (local midnight `windowDays - 1` days back) and `aggregate(records, now, { windowDays = 7 } = {}) -> { windowDays, from, to, totals, byDay, byJob, recent, skippedLines }`. `skippedLines` is always `0` here — `aggregate` never touches a file, so it cannot know; the CLI merges the real count in from `readLogRecords`. The field exists so the shape the page reads is complete from one place. `totals` is `{ runs, costUsd, outcomes: { success, failure, skipped, guardError }, skips: { usageLimit, apiOverload }, tokens: { in, out, cacheRead, cacheCreate }, turns, apiMs }`. `byDay` is exactly `windowDays` entries of `{ date, costUsd, runs }`, oldest first. `byJob` maps job id to `{ runs, costUsd, outcomes, lastTs }`. `recent` is at most 20 of `{ ts, job, kind, detail }`, newest first.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-shed/tools/__tests__/report.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { aggregate } from '../lib/report.mjs';

const NOW = new Date('2026-08-14T14:32:00').getTime();
const at = (iso: string) => new Date(iso).getTime();

const run = (over: Record<string, unknown> = {}) => ({
  ts: at('2026-08-14T10:00:00'), job: 'worker', exit: 0, timedOut: false,
  durationMs: 46_000, outcome: 'success', ...over,
});

describe('aggregate', () => {
  it('zero-fills the window and keeps the days oldest first', () => {
    const a = aggregate([], NOW);
    expect(a.byDay).toHaveLength(7);
    expect(a.byDay[0].date).toBe('2026-08-08');
    expect(a.byDay[6].date).toBe('2026-08-14');
    expect(a.byDay[6]).toEqual({ date: '2026-08-14', costUsd: null, runs: 0 });
  });

  it('sums cost and leaves it null when nothing was measured', () => {
    expect(aggregate([run()], NOW).totals.costUsd).toBeNull();
    const withCost = [run({ usage: { costUsd: 0.4 } }), run({ usage: { costUsd: 0.1 } })];
    expect(aggregate(withCost, NOW).totals.costUsd).toBeCloseTo(0.5, 6);
  });

  it('sums the cost that is known even when other runs carry none', () => {
    const a = aggregate([run(), run({ usage: { costUsd: 0.25 } })], NOW);
    expect(a.totals.costUsd).toBeCloseTo(0.25, 6);
    expect(a.totals.runs).toBe(2);
  });

  it('buckets days by LOCAL time, not by UTC', () => {
    // 01:30 local on the 14th is still the 13th in UTC on any timezone east of UTC.
    const a = aggregate([run({ ts: at('2026-08-14T01:30:00'), usage: { costUsd: 1 } })], NOW);
    const day = a.byDay.find((d) => d.date === '2026-08-14');
    expect(day?.runs).toBe(1);
    expect(day?.costUsd).toBe(1);
  });

  it('counts outcomes and splits the skip reasons', () => {
    const a = aggregate([
      run(), run({ outcome: 'failure', exit: 1 }),
      run({ outcome: 'skipped', reason: 'usage-limit' }),
      run({ outcome: 'skipped', reason: 'api-overload' }),
      run({ outcome: 'guard-error', exit: 3 }),
    ], NOW);
    expect(a.totals.outcomes).toEqual({ success: 1, failure: 1, skipped: 2, guardError: 1 });
    expect(a.totals.skips).toEqual({ usageLimit: 1, apiOverload: 1 });
    expect(a.totals.runs).toBe(5);
  });

  it('counts a run with an unknown outcome as a run but in no outcome bucket', () => {
    const a = aggregate([run({ outcome: 'cancelled' })], NOW);
    expect(a.totals.runs).toBe(1);
    expect(a.totals.outcomes).toEqual({ success: 0, failure: 0, skipped: 0, guardError: 0 });
  });

  it('treats a reclaim row as an event and never as a run', () => {
    const a = aggregate([
      { ts: at('2026-08-14T09:00:00'), job: null, action: 'reclaimed-deploy-pause', reclaimed: [{ scope: 'global' }] },
    ], NOW);
    expect(a.totals.runs).toBe(0);
    expect(a.recent[0].kind).toBe('reclaimed-deploy-pause');
    expect(a.recent[0].detail).toBe('reclaimed 1 pause(s)');
  });

  it('reports a timed-out run as a timeout event and a failure count', () => {
    const a = aggregate([run({ outcome: 'failure', exit: null, timedOut: true })], NOW);
    expect(a.totals.outcomes.failure).toBe(1);
    expect(a.recent[0].kind).toBe('timeout');
    expect(a.recent[0].detail).toBe('timeout (46s)');
  });

  it('splits cost per job and records the last timestamp', () => {
    const a = aggregate([
      run({ job: 'worker', usage: { costUsd: 2 } }),
      run({ job: 'chat', ts: at('2026-08-14T11:00:00'), usage: { costUsd: 0.5 } }),
    ], NOW);
    expect(a.byJob.worker.costUsd).toBe(2);
    expect(a.byJob.chat.runs).toBe(1);
    expect(a.byJob.chat.lastTs).toBe(at('2026-08-14T11:00:00'));
  });

  it('adds up tokens and skips fields that are not numbers', () => {
    const a = aggregate([
      run({ usage: { in: 10, out: 5, cacheRead: 'x', turns: 2 } }),
      run({ usage: { in: 4, cacheCreate: 3, apiMs: 100 } }),
    ], NOW);
    expect(a.totals.tokens).toEqual({ in: 14, out: 5, cacheRead: 0, cacheCreate: 3 });
    expect(a.totals.turns).toBe(2);
    expect(a.totals.apiMs).toBe(100);
  });

  it('returns recent newest first and caps it at 20', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      run({ ts: at('2026-08-14T10:00:00') + i * 1000, job: `j${i}` }));
    const a = aggregate(many, NOW);
    expect(a.recent).toHaveLength(20);
    expect(a.recent[0].job).toBe('j24');
  });

  it('ignores a record older than the window', () => {
    const a = aggregate([run({ ts: at('2026-07-01T10:00:00') })], NOW);
    expect(a.totals.runs).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/report.test.ts`
Expected: FAIL — cannot resolve `../lib/report.mjs`.

- [ ] **Step 3: Write the implementation**

Create `plugins/p-shed/tools/lib/report.mjs`:

```js
// Folds p-shed's own run log into the numbers the report page shows. Pure: no
// filesystem, no clock, no network. It must never throw — the scheduler's job is to
// schedule, and one strange log row must not be able to stop a render.

const OUTCOME_KEY = {
  success: 'success',
  failure: 'failure',
  skipped: 'skipped',
  'guard-error': 'guardError',
};

const SKIP_KEY = { 'usage-limit': 'usageLimit', 'api-overload': 'apiOverload' };

const RECENT_CAP = 20;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function secs(ms) {
  const n = num(ms);
  return n === null ? '' : ` (${Math.round(n / 1000)}s)`;
}

function runKind(rec) {
  if (rec.timedOut === true) return 'timeout';
  return OUTCOME_KEY[rec.outcome] ? String(rec.outcome) : 'unknown';
}

function runDetail(rec) {
  if (rec.timedOut === true) return `timeout${secs(rec.durationMs)}`;
  if (rec.outcome === 'skipped') return String(rec.reason ?? 'skipped');
  if (rec.outcome === 'guard-error') return `guard exit ${rec.exit ?? '?'}`;
  return `exit ${rec.exit ?? '?'}${secs(rec.durationMs)}`;
}

function eventDetail(rec) {
  if (rec.action === 'reclaimed-deploy-pause') {
    const n = Array.isArray(rec.reclaimed) ? rec.reclaimed.length : 0;
    return `reclaimed ${n} pause(s)`;
  }
  return String(rec.action);
}

function emptyOutcomes() {
  return { success: 0, failure: 0, skipped: 0, guardError: 0 };
}

// Local midnight `windowDays - 1` days back, so the last bucket is today. Exported
// because the CLI needs the same boundary to decide which log records to read at all.
//
// Stepping a Date with setDate survives a DST change; adding 86_400_000 does not, and
// would shift every day label by an hour for half the year.
export function windowStart(now, windowDays = 7) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (windowDays - 1));
  return start.getTime();
}

export function aggregate(records, now, { windowDays = 7 } = {}) {
  const from = windowStart(now, windowDays);

  const byDay = [];
  const dayIndex = new Map();
  const cursor = new Date(from);
  for (let i = 0; i < windowDays; i++) {
    const key = dayKey(cursor.getTime());
    dayIndex.set(key, i);
    byDay.push({ date: key, costUsd: null, runs: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  const totals = {
    runs: 0,
    costUsd: null,
    outcomes: emptyOutcomes(),
    skips: { usageLimit: 0, apiOverload: 0 },
    tokens: { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 },
    turns: 0,
    apiMs: 0,
  };
  const byJob = {};
  const events = [];

  for (const rec of Array.isArray(records) ? records : []) {
    const ts = num(rec?.ts);
    if (ts === null || ts < from) continue;
    const job = typeof rec.job === 'string' ? rec.job : null;

    // A row carrying `action` and no `outcome` is not a run — it is an event the tick
    // recorded (today: a reclaimed deploy pause). It moves no counter.
    if (rec.action !== undefined && rec.outcome === undefined) {
      events.push({ ts, job, kind: String(rec.action), detail: eventDetail(rec) });
      continue;
    }

    totals.runs++;
    const key = OUTCOME_KEY[rec.outcome];
    // An outcome this version does not know is still a run. `outcomes` may therefore sum
    // to less than `runs` when a newer p-shed writes a value we have never heard of —
    // better an honest headline than a silently dropped row.
    if (key) totals.outcomes[key]++;
    const skipKey = SKIP_KEY[rec.reason];
    if (rec.outcome === 'skipped' && skipKey) totals.skips[skipKey]++;

    const cost = num(rec.usage?.costUsd);
    if (cost !== null) totals.costUsd = (totals.costUsd ?? 0) + cost;
    for (const f of ['in', 'out', 'cacheRead', 'cacheCreate']) {
      const v = num(rec.usage?.[f]);
      if (v !== null) totals.tokens[f] += v;
    }
    const turns = num(rec.usage?.turns);
    if (turns !== null) totals.turns += turns;
    const apiMs = num(rec.usage?.apiMs);
    if (apiMs !== null) totals.apiMs += apiMs;

    const di = dayIndex.get(dayKey(ts));
    if (di !== undefined) {
      byDay[di].runs++;
      if (cost !== null) byDay[di].costUsd = (byDay[di].costUsd ?? 0) + cost;
    }

    if (job) {
      const j = byJob[job] ?? (byJob[job] = { runs: 0, costUsd: null, outcomes: emptyOutcomes(), lastTs: null });
      j.runs++;
      if (key) j.outcomes[key]++;
      if (cost !== null) j.costUsd = (j.costUsd ?? 0) + cost;
      if (j.lastTs === null || ts > j.lastTs) j.lastTs = ts;
    }

    events.push({ ts, job, kind: runKind(rec), detail: runDetail(rec) });
  }

  events.sort((a, b) => b.ts - a.ts);

  return {
    windowDays,
    from,
    to: now,
    totals,
    byDay,
    byJob,
    recent: events.slice(0, RECENT_CAP),
    skippedLines: 0,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run plugins/p-shed/tools/__tests__/report.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/report.mjs plugins/p-shed/tools/__tests__/report.test.ts
git commit -m "feat(p-shed): fold the run log into cost, outcome and per-job totals"
```

---

### Task 3: Next scheduled minute

**Files:**
- Modify: `plugins/p-shed/tools/lib/cron.mjs`
- Test: `plugins/p-shed/tools/__tests__/cron.test.ts`

**Interfaces:**
- Consumes: `parseCron(expr)` and `matches(cron, date)`, both already exported from this file.
- Produces: `nextRun(cron, fromMs) -> number | null`. `cron` is a parsed object from `parseCron`, not a string. The result is the epoch milliseconds of the first whole minute strictly after `fromMs` that the spec matches, or `null` when none falls within 400 days.

- [ ] **Step 1: Write the failing test**

Add to `plugins/p-shed/tools/__tests__/cron.test.ts`, extending the existing import from `../lib/cron.mjs` to include `nextRun`:

```ts
describe('nextRun', () => {
  const at = (iso: string) => new Date(iso).getTime();

  it('finds the next quarter hour', () => {
    const t = nextRun(parseCron('*/15 * * * *'), at('2026-08-14T10:07:30'));
    expect(t).toBe(at('2026-08-14T10:15:00'));
  });

  it('steps forward by exactly one minute, not two', () => {
    const t = nextRun(parseCron('*/15 * * * *'), at('2026-08-14T10:14:00'));
    expect(t).toBe(at('2026-08-14T10:15:00'));
  });

  it('never returns the minute it was asked from', () => {
    const t = nextRun(parseCron('*/15 * * * *'), at('2026-08-14T10:15:00'));
    expect(t).toBe(at('2026-08-14T10:30:00'));
  });

  it('rolls over to tomorrow for a daily schedule', () => {
    const t = nextRun(parseCron('0 9 * * *'), at('2026-08-14T10:00:00'));
    expect(t).toBe(at('2026-08-15T09:00:00'));
  });

  it('reaches a monthly schedule', () => {
    const t = nextRun(parseCron('0 0 1 * *'), at('2026-08-14T10:00:00'));
    expect(t).toBe(at('2026-09-01T00:00:00'));
  });

  it('returns null for a spec that can never match', () => {
    expect(nextRun(parseCron('0 0 30 2 *'), at('2026-08-14T10:00:00'))).toBeNull();
  });

  it('reaches a yearly schedule', () => {
    const t = nextRun(parseCron('0 0 1 1 *'), at('2026-08-14T10:00:00'));
    expect(t).toBe(at('2027-01-01T00:00:00'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cron.test.ts`
Expected: FAIL — `nextRun is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `plugins/p-shed/tools/lib/cron.mjs`:

```js
// The first whole minute strictly after `fromMs` that this spec matches, or null.
//
// It walks minute by minute through the same matcher the tick uses, so it can never
// disagree with it. 400 days covers a yearly schedule (`0 0 1 1 *`) from any starting
// day, with room to spare; the worst case is 576,000 matcher calls, which is still far
// cheaper than reading the logs the same command reads anyway. A spec that can never
// match — the 30th of February — returns null rather than spinning.
//
// One legal spec still reads as null despite having a real next run: a leap day
// (`0 0 29 2 *`) can be up to eight years away, spanning a non-leap century year like
// 2100. Covering that would cost millions of iterations for a schedule nobody writes,
// so it is left out on purpose.
export function nextRun(cron, fromMs) {
  const MIN = 60_000;
  const CAP = 400 * 24 * 60;
  let t = Math.floor(fromMs / MIN) * MIN + MIN;
  for (let i = 0; i < CAP; i++, t += MIN) {
    if (matches(cron, new Date(t))) return t;
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cron.test.ts`
Expected: PASS, all cases, and the pre-existing cron tests still green.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/cron.mjs plugins/p-shed/tools/__tests__/cron.test.ts
git commit -m "feat(p-shed): work out the next minute a cron spec fires"
```

---

### Task 4: What each job does next

**Files:**
- Modify: `plugins/p-shed/tools/lib/report.mjs`
- Test: `plugins/p-shed/tools/__tests__/report-next.test.ts`

**Interfaces:**
- Consumes: `parseCron`, `isDue`, `nextRun` from `./cron.mjs`; the effective job objects (`{ id, schedule, enabled }`) and the job entries `collectStatus` returns.
- Produces: `computeNext(jobs, statusJobs, now) -> { [jobId]: { at: number | null, due: boolean } }`. `at` is epoch milliseconds or `null` when the job has no next run. `due` is true when the job will launch on the next tick.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-shed/tools/__tests__/report-next.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeNext } from '../lib/report.mjs';

const at = (iso: string) => new Date(iso).getTime();
const NOW = at('2026-08-14T10:07:00');

const status = (over: Record<string, unknown> = {}) => ({
  id: 'worker', enabled: true, running: false, paused: false,
  breakerTripped: false, lastRun: at('2026-08-14T10:00:00'), ...over,
});

describe('computeNext', () => {
  it('gives the next matching minute for a job that is up to date', () => {
    const next = computeNext([{ id: 'worker', schedule: '*/15 * * * *', enabled: true }], [status()], NOW);
    expect(next.worker).toEqual({ at: at('2026-08-14T10:15:00'), due: false });
  });

  it('says due for a job whose slot already passed', () => {
    // Last ran yesterday, so the 09:00 slot this morning was missed and catch-up applies.
    const jobs = [{ id: 'worker', schedule: '0 9 * * *', enabled: true }];
    const next = computeNext(jobs, [status({ lastRun: at('2026-08-13T09:00:00') })], NOW);
    expect(next.worker.due).toBe(true);
  });

  it('follows the schedule it was given, so a profile override moves the answer', () => {
    const jobs = [{ id: 'worker', schedule: '0 */3 * * *', enabled: true }];
    const next = computeNext(jobs, [status()], NOW);
    expect(next.worker.at).toBe(at('2026-08-14T12:00:00'));
  });

  it('lets a pending retry win over the cron time', () => {
    const jobs = [{ id: 'worker', schedule: '*/15 * * * *', enabled: true }];
    const retryAt = at('2026-08-14T10:09:00');
    const next = computeNext(jobs, [status({ retryNotBefore: retryAt })], NOW);
    expect(next.worker).toEqual({ at: retryAt, due: false });
  });

  it('reports a retry whose moment has passed as due', () => {
    const jobs = [{ id: 'worker', schedule: '0 9 * * *', enabled: true }];
    const next = computeNext(jobs, [status({ retryNotBefore: at('2026-08-14T10:00:00') })], NOW);
    expect(next.worker.due).toBe(true);
  });

  it('has no next run for a disabled, paused or breaker-tripped job', () => {
    const jobs = [
      { id: 'off', schedule: '*/15 * * * *', enabled: false },
      { id: 'held', schedule: '*/15 * * * *', enabled: true },
      { id: 'broken', schedule: '*/15 * * * *', enabled: true },
    ];
    const next = computeNext(jobs, [
      status({ id: 'off', enabled: false }),
      status({ id: 'held', paused: true }),
      status({ id: 'broken', breakerTripped: true }),
    ], NOW);
    expect(next.off).toEqual({ at: null, due: false });
    expect(next.held).toEqual({ at: null, due: false });
    expect(next.broken).toEqual({ at: null, due: false });
  });

  it('has no next run for an unparseable schedule instead of throwing', () => {
    const next = computeNext([{ id: 'bad', schedule: 'not a cron', enabled: true }], [status({ id: 'bad' })], NOW);
    expect(next.bad).toEqual({ at: null, due: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/report-next.test.ts`
Expected: FAIL — `computeNext is not a function`.

- [ ] **Step 3: Write the implementation**

At the top of `plugins/p-shed/tools/lib/report.mjs` add the import:

```js
import { isDue, nextRun, parseCron } from './cron.mjs';
```

Then append:

```js
// When each job runs next, for the page's most-read column. Pure.
//
// Three rules sit above the raw matcher, and each one exists because without it the
// column would be confidently wrong:
//
//   1. `isDue` first. p-shed catches missed ticks up — it scans from
//      max(lastRun, now - 24h) — so a job whose slot passed while it was blocked is due
//      NOW. Printing nextRun()'s answer for such a job promises a time hours away for a
//      job that launches in sixty seconds.
//   2. The caller passes EFFECTIVE jobs (profile applied). A speed profile rewrites
//      `schedule` and `enabled` in memory, and status.mjs already resolves through
//      effectiveJobs so it "can never report a schedule the scheduler will not act on".
//      This function inherits that guarantee by never reading jobs.yml itself.
//   3. A pending `retryNotBefore` beats the cron time: the job relaunches then.
//
// A job that is disabled, paused, or breaker-tripped is not scheduled at all, and gets
// `at: null` rather than a time that will not happen.
export function computeNext(jobs, statusJobs, now) {
  const byId = new Map((statusJobs ?? []).map((j) => [j.id, j]));
  const out = {};
  for (const job of jobs ?? []) {
    const st = byId.get(job.id) ?? {};
    if (job.enabled === false || st.enabled === false || st.paused === true || st.breakerTripped === true) {
      out[job.id] = { at: null, due: false };
      continue;
    }
    const retry = num(st.retryNotBefore);
    if (retry !== null) {
      out[job.id] = retry > now ? { at: retry, due: false } : { at: null, due: true };
      continue;
    }
    let cron;
    try { cron = parseCron(job.schedule); }
    catch { out[job.id] = { at: null, due: false }; continue; }
    if (isDue(cron, st.lastRun ?? null, now)) {
      out[job.id] = { at: null, due: true };
      continue;
    }
    out[job.id] = { at: nextRun(cron, now), due: false };
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run plugins/p-shed/tools/__tests__/report-next.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/report.mjs plugins/p-shed/tools/__tests__/report-next.test.ts
git commit -m "feat(p-shed): decide when each job runs next, catch-up and retries included"
```

---

### Task 5: The daily cost chart

**Files:**
- Create: `plugins/p-shed/tools/lib/charts.mjs`
- Test: `plugins/p-shed/tools/__tests__/charts.test.ts`

**Interfaces:**
- Consumes: `byDay` entries from `aggregate`.
- Produces: `barsByDay(byDay, { width, height, series, muted, grid }) -> string`, a complete `<svg>…</svg>` element. Colors are passed in; this module holds no palette.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-shed/tools/__tests__/charts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { barsByDay } from '../lib/charts.mjs';

const opts = { width: 320, height: 96, series: '#2a78d6', muted: '#898781', grid: '#e1e0d9' };
const days = (costs: (number | null)[]) =>
  costs.map((c, i) => ({ date: `2026-08-0${i + 1}`, costUsd: c, runs: c === null ? 0 : 1 }));

describe('barsByDay', () => {
  it('draws one bar per day with a value', () => {
    const svg = barsByDay(days([1, 2, 3]), opts);
    expect((svg.match(/<path class="bar"/g) ?? []).length).toBe(3);
  });

  it('draws no bar for a day with no measured cost', () => {
    const svg = barsByDay(days([1, null, 3]), opts);
    expect((svg.match(/<path class="bar"/g) ?? []).length).toBe(2);
  });

  it('gives the tallest bar the full plot height', () => {
    const svg = barsByDay(days([1, 4]), opts);
    // height 96 - padTop 12 - axis band 14 = 70
    expect(svg).toContain('data-h="70"');
  });

  it('leaves a 2px gap between neighbouring bars', () => {
    const svg = barsByDay(days([1, 1]), opts);
    const xs = [...svg.matchAll(/data-x="([\d.]+)" data-w="([\d.]+)"/g)]
      .map((m) => ({ x: Number(m[1]), w: Number(m[2]) }));
    expect(xs[1].x - (xs[0].x + xs[0].w)).toBeCloseTo(2, 5);
  });

  it('sizes the viewBox to include the axis band', () => {
    expect(barsByDay(days([1]), opts)).toContain('viewBox="0 0 320 96"');
  });

  it('returns an empty state rather than a broken box for no data', () => {
    const svg = barsByDay([], opts);
    expect(svg).toContain('no runs yet');
    expect(svg).not.toContain('<path class="bar"');
  });

  it('returns an empty state when every day is zero', () => {
    expect(barsByDay(days([null, null]), opts)).toContain('no runs yet');
  });

  it('labels the first and last day only', () => {
    const svg = barsByDay(days([1, 2, 3]), opts);
    expect(svg).toContain('>08-01<');
    expect(svg).toContain('>08-03<');
    expect(svg).not.toContain('>08-02<');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/charts.test.ts`
Expected: FAIL — cannot resolve `../lib/charts.mjs`.

- [ ] **Step 3: Write the implementation**

Create `plugins/p-shed/tools/lib/charts.mjs`:

```js
// SVG for the one chart that needs real geometry. Pure: a string in, a string out.
//
// Only the daily chart is SVG. The cost-by-job bars on the page are plain <div>s with a
// percentage width — they need no geometry, they align with their label by construction,
// they reflow on a narrow screen where SVG text does not, and they keep every job name
// inside html.mjs, which is where escaping lives. A generator that drew job names would
// need its own copy of escapeHtml and would import it back from html.mjs, making the two
// modules circular.
//
// This module holds no colors. html.mjs owns the palette and passes it in, so light and
// dark are decided in exactly one place.

const PAD_T = 12;
const AXIS_H = 14;
const GAP = 2;      // surface gap between neighbouring bars — never a border on the bar
const RADIUS = 4;   // rounded data-end only; the baseline end stays square

// A vertical bar with a rounded top and a flat bottom, anchored on the baseline.
function barPath(x, y, w, h) {
  const r = Math.min(RADIUS, w / 2, h);
  return `M${x} ${y + h}V${y + r}a${r} ${r} 0 0 1 ${r} ${-r}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}V${y + h}Z`;
}

const round = (n) => Math.round(n * 100) / 100;

export function barsByDay(byDay, { width, height, series, muted, grid }) {
  const days = Array.isArray(byDay) ? byDay : [];
  const max = days.reduce((m, d) => Math.max(m, d.costUsd ?? 0), 0);
  const baseY = height - AXIS_H;

  const frame =
    `<line x1="0" y1="${baseY}" x2="${width}" y2="${baseY}" stroke="${grid}" stroke-width="1"/>`;

  if (!days.length || max <= 0) {
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="daily cost, no runs yet">`
      + frame
      + `<text x="${width / 2}" y="${baseY / 2}" fill="${muted}" font-size="11" text-anchor="middle">no runs yet</text>`
      + `</svg>`;
  }

  const plotH = height - PAD_T - AXIS_H;
  const slot = width / days.length;
  const barW = Math.max(1, slot - GAP);
  const bars = [];
  const labels = [];

  days.forEach((d, i) => {
    const x = round(i * slot + GAP / 2);
    if (d.costUsd !== null && d.costUsd > 0) {
      const h = round((d.costUsd / max) * plotH);
      const y = round(baseY - h);
      bars.push(
        `<path class="bar" d="${barPath(x, y, round(barW), h)}" fill="${series}" data-x="${x}" data-w="${round(barW)}" data-h="${h}"/>`,
      );
    }
    // Only the ends are labelled. A date under every bar is unreadable at phone width,
    // and the table view carries every value anyway.
    if (i === 0 || i === days.length - 1) {
      labels.push(
        `<text x="${round(x + barW / 2)}" y="${height - 3}" fill="${muted}" font-size="10" text-anchor="${i === 0 ? 'start' : 'end'}">${d.date.slice(5)}</text>`,
      );
    }
  });

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="daily cost over the window">`
    + frame + bars.join('') + labels.join('') + `</svg>`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run plugins/p-shed/tools/__tests__/charts.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/charts.mjs plugins/p-shed/tools/__tests__/charts.test.ts
git commit -m "feat(p-shed): draw the daily cost bars as inline SVG"
```

---

### Task 6: Render the page

**Files:**
- Create: `plugins/p-shed/tools/lib/html.mjs`
- Test: `plugins/p-shed/tools/__tests__/html.test.ts`

**Interfaces:**
- Consumes: `barsByDay` from `./charts.mjs`; the object `collectStatus` returns; the object `aggregate` returns; the map `computeNext` returns.
- Produces: `renderHtml(status, agg, next, now) -> string` (a complete HTML document) and `escapeHtml(text) -> string`.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-shed/tools/__tests__/html.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { escapeHtml, renderHtml } from '../lib/html.mjs';
import { aggregate } from '../lib/report.mjs';

const NOW = new Date('2026-08-14T14:32:00').getTime();
const at = (iso: string) => new Date(iso).getTime();

const status = (jobs: Record<string, unknown>[]) => ({
  action: 'status', task: 'pshed-1a2b3c4d', installed: true, paused: false, jobs,
});
const job = (over: Record<string, unknown> = {}) => ({
  id: 'worker', enabled: true, running: false, paused: false,
  breakerTripped: false, consecutiveFailures: 0, lastRun: at('2026-08-14T14:00:00'),
  lastExit: 0, ...over,
});
const page = (jobs: Record<string, unknown>[], next: Record<string, unknown> = {}) =>
  renderHtml(status(jobs), aggregate([], NOW), next, NOW);

describe('escapeHtml', () => {
  it('escapes the five characters that break markup', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
  it('survives values that are not strings', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('renderHtml', () => {
  it('produces a complete document naming the task', () => {
    const html = page([job()]);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('pshed-1a2b3c4d');
    expect(html).toContain('worker');
  });

  it('carries no script and loads nothing from the network', () => {
    const html = page([job({ pauseReason: 'x' })]);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });

  it('escapes text that came from outside', () => {
    const html = page([job({ paused: true, pauseOrigin: 'self', pauseReason: '<script>alert(1)</script>' })]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('counts a breaker, a self-pause and a retry as problems', () => {
    const html = page([
      job({ id: 'a', breakerTripped: true }),
      job({ id: 'b', paused: true, pauseOrigin: 'self' }),
      job({ id: 'c', lastSkipReason: 'api-overload', retryNotBefore: at('2026-08-14T15:00:00') }),
    ]);
    expect(html).toContain('3 problems');
  });

  it('does not count an operator pause as a problem', () => {
    const html = page([job({ paused: true, pauseOrigin: 'operator', pauseReason: 'holding' })]);
    expect(html).toContain('0 problems');
  });

  it('gives self-pause and operator-pause different badges', () => {
    const self = page([job({ paused: true, pauseOrigin: 'self', pauseReason: 'verify went red' })]);
    const operator = page([job({ paused: true, pauseOrigin: 'operator', pauseReason: 'holding' })]);
    expect(self).toContain('badge-self-pause');
    expect(operator).toContain('badge-held');
  });

  it('renders the next run as a time, as due, and as a dash', () => {
    const html = page(
      [job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })],
      { a: { at: at('2026-08-14T15:00:00'), due: false }, b: { at: null, due: true }, c: { at: null, due: false } },
    );
    expect(html).toContain('15:00');
    expect(html).toContain('>due<');
    expect(html).toContain('>—<');
  });

  it('shows a run cost of an unmeasured window as a dash, not as zero', () => {
    expect(page([job()])).not.toContain('$0.00');
  });

  it('defines both colour schemes', () => {
    const html = page([job()]);
    expect(html).toContain('#2a78d6');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('#3987e5');
  });

  it('puts a table view behind details for the daily chart', () => {
    expect(page([job()])).toContain('<details class="table-view"');
  });

  it('shows the generated time', () => {
    expect(page([job()])).toContain('14:32');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-shed/tools/__tests__/html.test.ts`
Expected: FAIL — cannot resolve `../lib/html.mjs`.

- [ ] **Step 3: Write the implementation**

Create `plugins/p-shed/tools/lib/html.mjs`:

```js
import { barsByDay } from './charts.mjs';

// The report page. Pure: everything it needs arrives as arguments, and it returns one
// self-contained HTML document.
//
// Two rules the page cannot break:
//   - No JavaScript and nothing fetched from the network. It is opened on a phone, often
//     on a bad connection, and a half-loaded dashboard is worse than a plain one. That is
//     why the charts are server-rendered and the expanders are native <details>.
//   - Every value that came from outside is escaped. Job ids, pause reasons, breaker
//     reasons and the raw output tail all reach this page from files a job can write.

const PALETTE = {
  light: { surface: '#fcfcfb', plane: '#f9f9f7', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', series: '#2a78d6' },
  dark: { surface: '#1a1a19', plane: '#0d0d0d', ink: '#ffffff', ink2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', series: '#3987e5' },
};

// Fixed status tokens, never themed. They are used ONE AT A TIME, each next to an icon
// and a text label — never as adjacent fills. Four of them side by side in a stacked bar
// fails the palette checks outright: critical against good measures dE 4.1 under
// deuteranopia, and serious against warning 13.6 for normal vision, below the floor of
// 15. That is why run outcomes on this page are four stat tiles and not one proportion
// bar. On the light surface warning (1.79) and serious (2.57) sit below 3:1 contrast, so
// their labels are what carry the meaning, not the colour.
const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };

export function escapeHtml(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const money = (v) => (typeof v === 'number' ? `$${v.toFixed(2)}` : '—');

// A job is in exactly one of these states, and the order is the precedence.
//
// Status colours are literal hex because they are mode-invariant by design — the same
// four steps clear their contrast floor on both surfaces. The two non-status colours are
// `var(...)` instead: the series blue and the muted grey have a different step per mode,
// and a literal here would freeze the light step onto the dark surface.
function jobState(j) {
  if (j.breakerTripped) return { key: 'breaker', label: 'breaker', icon: '⛔', color: STATUS.critical, problem: true };
  if (j.paused && j.pauseOrigin === 'self') return { key: 'self-pause', label: 'paused itself', icon: '⏸', color: STATUS.serious, problem: true };
  if (j.paused) return { key: 'held', label: `paused (${j.pauseOrigin ?? 'operator'})`, icon: '⏸', color: 'var(--muted)', problem: false };
  if (j.retryNotBefore != null) return { key: 'retry', label: 'retry pending', icon: '⏳', color: STATUS.warning, problem: true };
  if (j.running) return { key: 'running', label: 'running', icon: '●', color: 'var(--series)', problem: false };
  if (j.enabled === false) return { key: 'off', label: 'disabled', icon: '○', color: 'var(--muted)', problem: false };
  return { key: 'ok', label: 'ok', icon: '○', color: STATUS.good, problem: false };
}

function nextLabel(entry) {
  if (!entry) return '—';
  if (entry.due) return 'due';
  return entry.at == null ? '—' : hhmm(entry.at);
}

function css() {
  const l = PALETTE.light, d = PALETTE.dark;
  const vars = (p) => `--surface:${p.surface};--plane:${p.plane};--ink:${p.ink};--ink2:${p.ink2};--muted:${p.muted};--grid:${p.grid};--series:${p.series};`;
  return `
:root{color-scheme:light;${vars(l)}}
@media (prefers-color-scheme: dark){:root{color-scheme:dark;${vars(d)}}}
*{box-sizing:border-box}
body{margin:0;padding:12px;background:var(--plane);color:var(--ink);
  font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));max-width:1200px;margin:0 auto}
.card{background:var(--surface);border:1px solid var(--grid);border-radius:8px;padding:12px}
h1{font-size:15px;margin:0 0 2px}
h2{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 8px;font-weight:600}
.sub{color:var(--ink2);font-size:12px}
.hero{font-size:28px;margin:2px 0 8px}
.badge{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.row{display:flex;justify-content:space-between;gap:8px;align-items:baseline;padding:3px 0}
.bar-track{height:8px;background:var(--grid);border-radius:0 4px 4px 0;margin-top:3px}
.bar-fill{height:8px;background:var(--series);border-radius:0 4px 4px 0}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;text-align:center}
.tile-n{font-size:20px}
.tile-l{font-size:11px;color:var(--ink2)}
table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
td{padding:2px 0;border-top:1px solid var(--grid)}
td+td{text-align:right}
pre{white-space:pre-wrap;word-break:break-word;font-size:11px;color:var(--ink2);margin:6px 0 0}
details{margin-top:8px}
summary{cursor:pointer;color:var(--muted);font-size:12px}
.reason{color:var(--ink2);font-size:12px;margin-top:2px}`;
}

// The state key rides along as a class so tests can assert WHICH badge was chosen —
// self-pause and operator-pause differ only in colour and wording otherwise, and that
// distinction is the point.
function badge(state) {
  return `<span class="badge badge-${state.key}" style="color:${state.color}"><span class="dot" style="background:${state.color}"></span>${state.icon} ${escapeHtml(state.label)}</span>`;
}

function problemCard(j, state, next, agg) {
  const cost = agg.byJob[j.id]?.costUsd;
  const detail = [
    j.breakerTripped && j.consecutiveFailures ? `${j.consecutiveFailures} fails in a row` : '',
    j.lastRun ? `last ${hhmm(j.lastRun)}${j.lastExit == null ? '' : ` · exit ${escapeHtml(j.lastExit)}`}` : 'never run',
    j.lastSkipReason ? escapeHtml(j.lastSkipReason) : '',
    `next ${nextLabel(next[j.id])}`,
    cost != null ? money(cost) : '',
  ].filter(Boolean).join(' · ');
  const reason = j.pauseReason ?? j.breakerReason;
  return `<div class="card">
<div class="row"><strong>${escapeHtml(j.id)}</strong>${badge(state)}</div>
<div class="sub">${detail}</div>
${reason ? `<div class="reason">“${escapeHtml(reason)}”</div>` : ''}
</div>`;
}

function costCard(agg) {
  const max = Object.values(agg.byJob).reduce((m, j) => Math.max(m, j.costUsd ?? 0), 0);
  const rows = Object.entries(agg.byJob)
    .filter(([, j]) => j.costUsd != null)
    .sort((a, b) => b[1].costUsd - a[1].costUsd);
  const top = rows.slice(0, 8);
  const rest = rows.slice(8).reduce((s, [, j]) => s + j.costUsd, 0);
  if (rest > 0) top.push(['other', { costUsd: rest }]);

  const bars = top.map(([id, j]) => `<div>
<div class="row"><span>${escapeHtml(id)}</span><span>${money(j.costUsd)}</span></div>
<div class="bar-track"><div class="bar-fill" style="width:${max > 0 ? Math.round((j.costUsd / max) * 100) : 0}%"></div></div>
</div>`).join('');

  const table = agg.byDay.map((d) =>
    `<tr><td>${escapeHtml(d.date)}</td><td>${d.runs}</td><td>${money(d.costUsd)}</td></tr>`).join('');

  return `<div class="card">
<h2>Cost · ${agg.windowDays} days</h2>
<div class="hero">${money(agg.totals.costUsd)}</div>
${barsByDay(agg.byDay, { width: 320, height: 96, series: PALETTE.light.series, muted: PALETTE.light.muted, grid: PALETTE.light.grid })}
${bars ? `<h2 style="margin-top:12px">Where it goes</h2>${bars}` : ''}
<details class="table-view"><summary>table</summary>
<table><tr><td>day</td><td>runs</td><td>cost</td></tr>${table}</table></details>
</div>`;
}

function runsCard(agg) {
  const o = agg.totals.outcomes;
  const tile = (n, label, color) =>
    `<div><div class="tile-n" style="color:${color}">${n}</div><div class="tile-l">${label}</div></div>`;
  return `<div class="card">
<h2>Runs · ${agg.windowDays} days</h2>
<div class="hero">${agg.totals.runs}</div>
<div class="tiles">
${tile(o.success, 'ok', STATUS.good)}
${tile(o.failure, 'failed', STATUS.critical)}
${tile(o.skipped, 'skipped', STATUS.warning)}
${tile(o.guardError, 'guard err', STATUS.serious)}
</div>
<div class="sub" style="margin-top:8px">usage-limit ${agg.totals.skips.usageLimit} · overload ${agg.totals.skips.apiOverload}</div>
</div>`;
}

function jobsCard(jobs, agg, next) {
  const rows = jobs.map((j) => {
    const state = jobState(j);
    const cost = agg.byJob[j.id]?.costUsd;
    return `<tr><td>${escapeHtml(j.id)} ${badge(state)}</td><td>${nextLabel(next[j.id])}</td><td>${money(cost)}</td></tr>`;
  }).join('');
  return `<div class="card"><h2>Jobs</h2><table><tr><td>job</td><td>next</td><td>cost</td></tr>${rows}</table></div>`;
}

function recentCard(agg) {
  const rows = agg.recent.map((e) =>
    `<tr><td>${hhmm(e.ts)} ${escapeHtml(e.job ?? '—')}</td><td>${escapeHtml(e.detail)}</td></tr>`).join('');
  return `<div class="card"><h2>Recent</h2><table>${rows || '<tr><td>nothing yet</td></tr>'}</table></div>`;
}

export function renderHtml(status, agg, next, now) {
  const states = status.jobs.map((j) => ({ j, state: jobState(j) }));
  const problems = states.filter((s) => s.state.problem);
  const healthy = states.filter((s) => !s.state.problem);
  const head = `${problems.length} problem${problems.length === 1 ? '' : 's'} · ${money(agg.totals.costUsd)} / ${agg.windowDays}d`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>p-shed · ${escapeHtml(status.task)}</title>
<style>${css()}</style></head>
<body>
<div class="grid">
<div class="card">
<h1>p-shed · ${escapeHtml(status.task)}</h1>
<div class="sub">${head}</div>
<div class="sub">generated ${hhmm(now)} · cron ${status.installed === null ? 'unknown' : status.installed ? 'installed' : 'NOT installed'}${status.profile?.name ? ` · profile ${escapeHtml(status.profile.name)}` : ''}${status.paused ? ' · SCHEDULER PAUSED' : ''}</div>
</div>
${problems.map(({ j, state }) => problemCard(j, state, next, agg)).join('')}
${costCard(agg)}
${runsCard(agg)}
${jobsCard(healthy.map((s) => s.j), agg, next)}
${recentCard(agg)}
<div class="card sub">window ${agg.windowDays} days · ${agg.skippedLines} unreadable log line(s)</div>
</div>
</body></html>`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run plugins/p-shed/tools/__tests__/html.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/tools/lib/html.mjs plugins/p-shed/tools/__tests__/html.test.ts
git commit -m "feat(p-shed): render the report page, problems first, no script and no network"
```

---

### Task 7: The `report` command

**Files:**
- Modify: `plugins/p-shed/tools/pshed.mjs`
- Test: `plugins/p-shed/tools/__tests__/cli-report-e2e.test.ts`
- Test: `plugins/p-shed/tools/__tests__/stdout-pipe.test.ts`

**Interfaces:**
- Consumes: `readLogRecords` (Task 1), `aggregate` and `computeNext` (Tasks 2 and 4), `renderHtml` (Task 6), plus the file's own `collectStatus`, `effectiveJobs`, `isTickInstalled`, `readJobs`, `readConfig`, `parseArgs`, `die`, and `ValidationError`.
- Produces: the CLI command `pshed report [--out <path>]`.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-shed/tools/__tests__/cli-report-e2e.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../pshed.mjs', import.meta.url));
let root: string;

const run = (args: string[]) => {
  try {
    return { out: execFileSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf-8' }), code: 0 };
  } catch (e: any) {
    return { out: String(e.stdout ?? ''), code: e.status as number };
  }
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pshed-report-'));
  mkdirSync(join(root, '.pshed', 'logs'), { recursive: true });
  writeFileSync(join(root, '.pshed', 'jobs.yml'),
    'version: 1\njobs:\n  - id: worker\n    schedule: "*/15 * * * *"\n    prompt: "x"\n');
  writeFileSync(join(root, '.pshed', 'logs', '2026-08-14.jsonl'),
    JSON.stringify({ ts: Date.now(), job: 'worker', exit: 0, outcome: 'success', durationMs: 1000, usage: { costUsd: 1.25 } }) + '\n');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('pshed report', () => {
  it('writes an HTML document to stdout', () => {
    const { out, code } = run(['report']);
    expect(code).toBe(0);
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('worker');
  });

  it('writes the file with --out and leaves no temp file behind', () => {
    const target = join(root, 'board.html');
    expect(run(['report', '--out', target]).code).toBe(0);
    expect(readFileSync(target, 'utf-8')).toContain('<!doctype html>');
    expect(readdirSync(root).filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it('changes nothing under .pshed', () => {
    const before = readdirSync(join(root, '.pshed')).sort();
    run(['report']);
    expect(readdirSync(join(root, '.pshed')).sort()).toEqual(before);
  });

  it('exits 2 when --out has no value', () => {
    expect(run(['report', '--out']).code).toBe(2);
  });

  it('exits 1 when there is no .pshed directory', () => {
    rmSync(join(root, '.pshed'), { recursive: true, force: true });
    expect(run(['report']).code).toBe(1);
  });

  it('exits 1 and leaves nothing behind when the target cannot be written', () => {
    const target = join(root, 'no-such-dir', 'board.html');
    expect(run(['report', '--out', target]).code).toBe(1);
    expect(readdirSync(root).filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it('renders a job that has never run', () => {
    writeFileSync(join(root, '.pshed', 'jobs.yml'),
      'version: 1\njobs:\n  - id: fresh\n    schedule: "0 9 * * *"\n    prompt: "x"\n');
    const { out, code } = run(['report']);
    expect(code).toBe(0);
    expect(out).toContain('fresh');
  });

  it('reports unreadable log lines in the footer', () => {
    writeFileSync(join(root, '.pshed', 'logs', '2026-08-13.jsonl'), '{"ts":1,\n');
    expect(run(['report']).out).toContain('1 unreadable log line(s)');
  });
});
```

Then add one case to the existing `describe('stdout survives a pipe')` block in `plugins/p-shed/tools/__tests__/stdout-pipe.test.ts`, reusing that file's own `seedScheduler`, `throughPipe` and `throughFile` helpers — do not introduce new ones:

```ts
  it('report through a pipe is complete — the largest page this CLI writes', () => {
    // seedScheduler makes 150 breaker-tripped jobs whose reasons are ~2 KB each, so the
    // page is several hundred KB: far past the 64 KB a truncating exit caps output at.
    // Green on win32 no matter how broken the code is — pipe writes are synchronous
    // there. It only means something under WSL.
    seedScheduler();
    const piped = throughPipe(['report']);
    const file = throughFile(['report']);

    expect(piped.status).toBe(0);
    expect(piped.stdout.length).toBeGreaterThan(PIPE_BUFFER);
    expect(piped.stdout).toBe(file.stdout);
    expect(piped.stdout.trimEnd().endsWith('</html>')).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cli-report-e2e.test.ts`
Expected: FAIL — the CLI prints its usage and exits non-zero, because `report` is not a known command.

- [ ] **Step 3: Write the implementation**

In `plugins/p-shed/tools/pshed.mjs`, three of the existing imports change and three are new. `readJobs`, `readConfig` (line 5), `effectiveJobs` (line 7) and `collectStatus` (line 18) are already there and need no edit. `paths`, `renameSync` and `rmSync` are not:

```js
// line 2 — add renameSync and rmSync
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
// line 5 — add paths
import { paths, readJobs, readConfig } from './lib/io.mjs';
// new
import { readLogRecords } from './lib/logs.mjs';
import { aggregate, computeNext, windowStart } from './lib/report.mjs';
import { renderHtml } from './lib/html.mjs';
```

Add the command next to `status` in the dispatch:

```js
    if (command === 'report') {
      const out = args.out;
      if (out === true) return die('--out requires a value', 2);
      if (!existsSync(paths(root).dir)) return die(`no ${paths(root).dir} — run init first`, 1);

      const now = Date.now();
      const status = collectStatus(root, { installed: isTickInstalled(root) });
      const { jobs } = effectiveJobs({ root, jobsData: readJobs(root), config: readConfig(root) });
      const { records, skippedLines } = readLogRecords(root, windowStart(now));
      // aggregate reads no files, so it cannot count unreadable lines itself.
      const agg = { ...aggregate(records, now), skippedLines };
      const html = renderHtml(status, agg, computeNext(jobs, status.jobs, now), now);

      if (!out) {
        // Never process.exit() here: this is the biggest thing the CLI writes, and a hard
        // exit drops everything still queued on the pipe.
        process.stdout.write(html);
        return;
      }
      // Atomic, like run/DEPLOY: a temp file in the SAME directory, then rename. A plain
      // write can be fetched half-finished by the browser that is refreshing the page,
      // and rename is only atomic within one filesystem.
      const tmp = `${out}.${process.pid}.${now}.tmp`;
      try {
        writeFileSync(tmp, html, 'utf-8');
        renameSync(tmp, out);
      } catch (err) {
        rmSync(tmp, { force: true });
        return die(`cannot write ${out}: ${err.message}`, 1);
      }
      return;
    }
```

Add `report` to the usage text the CLI prints for an unknown command, next to `status`:

```
  report [--out <path>]     render the HTML report to stdout or a file
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run plugins/p-shed/tools/__tests__/cli-report-e2e.test.ts plugins/p-shed/tools/__tests__/stdout-pipe.test.ts plugins/p-shed/tools/__tests__/cli-entry.test.ts`
Expected: PASS, all cases, including the pre-existing entry test that asserts the usage text.

- [ ] **Step 5: Run the whole suite on both platforms**

Run on Windows: `npx vitest run`
Run under WSL: `wsl -e bash -lc 'export PATH=$HOME/.local/node24/bin:$PATH && cd ~/pshed && npx vitest run'`
Expected: PASS on both. The WSL run is the one that counts — see `.claude/CLAUDE.md`. If the WSL copy does not exist yet, create it as described there; a missing tool in WSL is a setup step, never a reason to skip the run.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-shed/tools/pshed.mjs plugins/p-shed/tools/__tests__/cli-report-e2e.test.ts plugins/p-shed/tools/__tests__/stdout-pipe.test.ts
git commit -m "feat(p-shed): add the report command, writing the page atomically"
```

---

### Task 8: Document it

**Files:**
- Modify: `plugins/p-shed/README.md`
- Modify: `plugins/p-shed/CLAUDE.md`

**Interfaces:**
- Consumes: the finished command from Task 7.
- Produces: nothing other modules use.

- [ ] **Step 1: Add the command to the README command table**

In the `## Commands` table in `plugins/p-shed/README.md`, after the `status` row:

```markdown
| `report` `[--out <path>]` | Render a self-contained HTML page — cost over the last 7 days, what is broken, what runs next — to stdout, or atomically to a file. Read-only: it writes nothing under `.pshed/` and needs no network. |
```

- [ ] **Step 2: Add the delivery recipe to the README**

Add this section after `## Stopping, pausing, and status`:

```markdown
## Looking at the loop from a phone

`pshed report` only prints a page. Serving it is the operator's own setup — p-shed has
no HTTP server and will not grow one.

Render it on a schedule with a guard-only job, so a broken render trips the breaker
instead of failing silently:

    - id: board
      schedule: "*/5 * * * *"
      guard: "node /path/to/p-shed/tools/pshed.mjs report --out /home/me/board/index.html && exit 75"
      prompt: "(guard-only) Render the board."

Then point any static file server at that folder. With caddy:

    :8080 {
        root * /home/me/board
        file_server
        basicauth { me <bcrypt-hash> }
    }

Three things worth getting right the first time:

- **Keep the output folder owned by the user the loop runs as** (`/home/me/board`), not
  `/var/www`. A permission error inside a guard is an unpleasant place to debug.
- **Do not skip the password.** The page shows job prompts, pause reasons, and the tail
  of a failed run's output. On a home network, everyone on it can read that.
- **The page is only as fresh as the job that wrote it.** It carries the time it was
  generated, in the header — that stamp is how a dead render job becomes visible.

Reaching it from outside the network needs a tunnel you install yourself. Nothing here
blocks that, and nothing here helps.
```

- [ ] **Step 2b: Note the page's fixed cost in the README limits**

Add one bullet to `## Known limitations`:

```markdown
- **The report covers only the last 7 days**, because that is how long `logs/` is kept.
  A longer trend needs a retention change, which this does not include.
```

- [ ] **Step 3: Record the decisions in the contributor guide**

Add to `plugins/p-shed/CLAUDE.md`:

```markdown
- **`report` renders; it never serves.** p-shed has no HTTP server, no port, and no
  access decision, and must not grow one — delivery is an off-the-shelf static file
  server the operator runs, wired up in `jobs.yml` like any other job. A dashboard
  plugin that read `.pshed/` from outside was considered and rejected: that is exactly
  what p-observe did, and it had to keep its own parser for `jobs.yml` in step with
  this one.
- **The page carries no JavaScript and fetches nothing.** Charts are server-rendered
  SVG; expanders are native `<details>`. It is read on a phone, and a half-loaded
  dashboard is worse than a plain one. `__tests__/html.test.ts` pins the absence of
  `<script`, `http://` and `https://`.
- **Run outcomes are four stat tiles, never one stacked proportion bar.** The four
  status colours fail the palette checks as adjacent fills — critical against good
  measures dE 4.1 under deuteranopia, serious against warning 13.6 for normal vision,
  under a floor of 15. Status colours are built to be read one at a time, next to an
  icon and a label. Do not "tidy" the tiles back into a bar.
- **`computeNext` asks `isDue` before `nextRun`.** p-shed catches missed ticks up, so a
  job whose slot passed is due NOW; `nextRun` alone would print a time hours away for a
  job that launches in sixty seconds. It also reads the EFFECTIVE schedule (profiles
  rewrite `schedule` in memory) and lets a pending `retryNotBefore` win over cron.
- **Day buckets come from `ts` in local time, never from the log file name.** Log files
  are named by UTC date while schedules fire in local time; on UTC+3 the two disagree by
  three hours, and bucketing by file name silently drops the local end of the window.
```

- [ ] **Step 4: Check the docs render and the claims are true**

Run: `npx vitest run plugins/p-shed/tools/__tests__/skills-structure.test.ts`
Expected: PASS. Then read the new README section back and confirm every path, flag, and exit code in it matches Task 7's implementation.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-shed/README.md plugins/p-shed/CLAUDE.md
git commit -m "docs(p-shed): document the report command and how to serve it"
```

---

## After the plan

The plugin's version is **not** bumped by these tasks. Releasing is a separate, explicit
step: `.claude/CLAUDE.md` requires stating the proposed monorepo tag and per-plugin bumps
and waiting for confirmation before tagging. A plugin's source cannot ship without its
`plugin.json#version` moving, so the release step is required before this reaches anyone —
it is simply not part of this plan.
