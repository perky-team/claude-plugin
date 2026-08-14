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
