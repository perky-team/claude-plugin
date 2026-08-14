// Folds p-shed's own run log into the numbers the report page shows. Pure: no
// filesystem, no clock, no network. It must never throw — the scheduler's job is to
// schedule, and one strange log row must not be able to stop a render.

import { isDue, nextRun, parseCron } from './cron.mjs';

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
  // Holds both real events and run rows; every entry here ends up in `recent`.
  const feed = [];

  for (const rec of Array.isArray(records) ? records : []) {
    const ts = num(rec?.ts);
    if (ts === null || ts < from) continue;
    const job = typeof rec.job === 'string' ? rec.job : null;

    // A row carrying `action` and no `outcome` is not a run — it is an event the tick
    // recorded (today: a reclaimed deploy pause). It moves no counter.
    if (rec.action !== undefined && rec.outcome === undefined) {
      feed.push({ ts, job, kind: String(rec.action), detail: eventDetail(rec) });
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
      const j = byJob[job] ?? (byJob[job] = { runs: 0, costUsd: null, outcomes: emptyOutcomes(), lastTs: null, lastRaw: null, lastRawTs: null });
      j.runs++;
      if (key) j.outcomes[key]++;
      if (cost !== null) j.costUsd = (j.costUsd ?? 0) + cost;
      if (j.lastTs === null || ts > j.lastTs) j.lastTs = ts;
      // The problem card on the report page shows what a failing job printed. p-shed
      // already truncates this to about 2 KB when it writes the log line (tick.mjs's
      // truncateOutput), so it is kept as-is here — never re-truncated — and only the
      // newest one per job survives. `success` never carries a raw field by p-shed's
      // own design, but the outcome check is kept explicit rather than trusting that.
      if (rec.outcome !== 'success' && typeof rec.raw === 'string' && rec.raw
          && (j.lastRawTs === null || ts > j.lastRawTs)) {
        j.lastRaw = rec.raw;
        j.lastRawTs = ts;
      }
    }

    feed.push({ ts, job, kind: runKind(rec), detail: runDetail(rec) });
  }

  feed.sort((a, b) => b.ts - a.ts);

  return {
    windowDays,
    from,
    to: now,
    totals,
    byDay,
    byJob,
    recent: feed.slice(0, RECENT_CAP),
    // aggregate() reads no files, so it cannot count unreadable ones itself — these are
    // placeholders the CLI overwrites with readLogRecords()'s real counts.
    skippedLines: 0,
    skippedFiles: 0,
  };
}

// When each job runs next, for the page's most-read column. Pure.
//
// `due` means one thing: the tick will launch this job on its very next run. Every rule
// below exists because some state makes the raw matcher answer something else:
//
//   1. The caller passes EFFECTIVE jobs (profile applied). A speed profile rewrites
//      `schedule` and `enabled` in memory, and status.mjs already resolves through
//      effectiveJobs so it "can never report a schedule the scheduler will not act on".
//      This function inherits that guarantee by never reading jobs.yml itself.
//   2. A job whose own previous run is still alive gets `at: null`, not a guessed time.
//      Checked before the never-run rule below, on purpose: `pshed run <id>` launches a
//      job by hand and stays stateless — it writes the pidfile and never touches the
//      state file — so `{ lastRun: null, running: true }` is reachable and ordinary,
//      not a contradiction. That is a freshly added job, started this way before the
//      scheduler has ticked it even once, and it must land here, not in rule 3. What
//      actually protects it on the tick side is the BASELINE gate, not the pid check:
//      tick.mjs's `!st || lastRun == null` branch fires first for exactly this state,
//      writes a fresh baseline, and moves on — the pid-alive duplicate guard sits later
//      in the same function and is never reached. `lastRun` marks when the run STARTED, and
//      `nextRun` only answers "the next matching cron minute from now" — it has no idea
//      the run is still going and will still be going when that minute arrives. Printing
//      that guess named a launch the tick would simply not make, and since the
//      page re-renders on a schedule, the guessed time slid forward every render — a job
//      truly stuck forever read as "coming up soon" forever, indistinguishable from a
//      healthy wait. `at: null` puts it in the same honest "don't know" bucket as a
//      disabled or paused job.
//   3. A job that is not running and has no `lastRun` has never run. The tick's baseline
//      gate (tick.mjs, the `!st || lastRun == null` branch) writes a starting point and
//      skips THAT tick rather than launching, so `isDue` must never be asked about this
//      job — it would say yes for anything more frequent than daily, since it treats a
//      missing `lastRun` as "24 hours ago".
//   4. A pending `retryNotBefore` beats the cron time: the job relaunches then. Checked
//      before `isDue` so a missed slot with a still-future backoff reports the backoff
//      time, not a launch that will not happen.
//   5. `isDue` last. p-shed catches missed ticks up — it scans from
//      max(lastRun, now - 24h) — so a job whose slot passed while it was blocked is due
//      NOW. Printing nextRun()'s answer for such a job promises a time hours away for a
//      job that launches in sixty seconds.
//
// A job that is disabled, paused, or breaker-tripped is not scheduled at all, and gets
// `at: null` rather than a time that will not happen.
//
// Three tick gates are NOT modelled here. A job can read as `due` (or get a guessed
// `at`) above even though the tick will skip it for one of these reasons:
//
//   1. The concurrency-group gate (`skipped-group`). This function already sees every
//      job and every status in one call, so cross-referencing `running` across
//      groupmates is not the blocker. The real blocker: its signature carries no
//      `defaults`, so it cannot resolve a group a job inherits from
//      `defaults.concurrencyGroup` instead of naming directly on the job.
//   2. The guard verdict. A due job can still carry a `guard` command that exits 75
//      ("quiet, nothing to do right now") and the tick will not launch it — this
//      function never runs the guard, so it cannot know.
//   3. The global scheduler pause (`run/PAUSED`), which stops every job at once before
//      the tick even looks at jobs.yml. This is not a gap in what this function sees —
//      `collectStatus` returns the global pause as one top-level field, not a per-job
//      one — so the report page can and does show it on its own, even though
//      `computeNext` has no way to know it from the inputs it is given.
export function computeNext(jobs, statusJobs, now) {
  const byId = new Map((statusJobs ?? []).map((j) => [j.id, j]));
  const out = {};
  for (const job of jobs ?? []) {
    const st = byId.get(job.id) ?? {};
    if (job.enabled === false || st.enabled === false || st.paused === true || st.breakerTripped === true) {
      out[job.id] = { at: null, due: false };
      continue;
    }
    let cron;
    try { cron = parseCron(job.schedule); }
    catch { out[job.id] = { at: null, due: false }; continue; }

    if (st.running === true) {
      out[job.id] = { at: null, due: false };
      continue;
    }
    if (st.lastRun == null) {
      out[job.id] = { at: nextRun(cron, now), due: false };
      continue;
    }

    const retry = num(st.retryNotBefore);
    if (retry !== null) {
      out[job.id] = retry > now ? { at: retry, due: false } : { at: null, due: true };
      continue;
    }
    if (isDue(cron, st.lastRun, now)) {
      out[job.id] = { at: null, due: true };
      continue;
    }
    out[job.id] = { at: nextRun(cron, now), due: false };
  }
  return out;
}
