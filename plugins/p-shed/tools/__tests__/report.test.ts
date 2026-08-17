import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aggregate, windowStart } from '../lib/report.mjs';

const NOW = new Date('2026-08-14T14:32:00').getTime();
const at = (iso: string) => new Date(iso).getTime();

const run = (over: Record<string, unknown> = {}) => ({
  ts: at('2026-08-14T10:00:00'), job: 'worker', exit: 0, timedOut: false,
  durationMs: 46_000, outcome: 'success', ...over,
});

// Forces the process timezone for every test in the enclosing describe block, then
// puts back whatever was there before. Some properties (DST-safe date stepping,
// local-vs-UTC bucketing) only show up in a timezone the test host itself may not be
// running in, so the test must pick its own timezone rather than trust the host's.
function withTZ(tz: string) {
  let prev: string | undefined;
  beforeAll(() => {
    prev = process.env.TZ;
    process.env.TZ = tz;
  });
  afterAll(() => {
    // Assigning `undefined` back would coerce to the string "undefined" and force
    // UTC, not "no override" — so an originally-unset TZ must be deleted, not restored.
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  });
}

// Calendar-day distance between two 'YYYY-MM-DD' labels, computed in UTC so the
// answer never depends on either date's own DST offset.
function dayNumber(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

describe('aggregate', () => {
  it('zero-fills the window and keeps the days oldest first', () => {
    const a = aggregate([], NOW);
    expect(a.byDay).toHaveLength(7);
    expect(a.byDay[0].date).toBe('2026-08-08');
    expect(a.byDay[6].date).toBe('2026-08-14');
    expect(a.byDay[6]).toEqual({ date: '2026-08-14', costUsd: null, runs: 0, usageLimit: 0, apiOverload: 0 });
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

  describe('buckets days by LOCAL time, not by UTC', () => {
    // East of UTC, 01:30 local on the 14th is the 13th in UTC — that is what a
    // UTC-based bug would get wrong. West of UTC the two land on the same UTC
    // calendar day anyway, so the test is only a real check when forced east.
    withTZ('Europe/Berlin');

    it('buckets a 01:30 local run into its own local day', () => {
      // Parsed fresh here, under the forced TZ — the module-level NOW/at were
      // parsed under the host's own timezone, before this block took over.
      const now = new Date('2026-08-14T14:32:00').getTime();
      const ts = new Date('2026-08-14T01:30:00').getTime();
      const a = aggregate([run({ ts, usage: { costUsd: 1 } })], now);
      const day = a.byDay.find((d) => d.date === '2026-08-14');
      expect(day?.runs).toBe(1);
      expect(day?.costUsd).toBe(1);
    });
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

  it('leaves a job costUsd null, never 0, when none of its runs carry usage.costUsd', () => {
    const a = aggregate([run({ job: 'worker' })], NOW);
    expect(a.byJob.worker.costUsd).toBeNull();
  });

  it('keeps the most recent non-success run\'s raw tail per job, unmodified', () => {
    const a = aggregate([
      run({ job: 'worker', outcome: 'failure', exit: 1, raw: 'first failure output', ts: at('2026-08-14T09:00:00') }),
      run({ job: 'worker', outcome: 'failure', exit: 1, raw: 'second failure output', ts: at('2026-08-14T10:00:00') }),
    ], NOW);
    expect(a.byJob.worker.lastRaw).toBe('second failure output');
  });

  it('picks the newer raw tail regardless of record order', () => {
    const a = aggregate([
      run({ job: 'worker', outcome: 'failure', exit: 1, raw: 'newer', ts: at('2026-08-14T10:00:00') }),
      run({ job: 'worker', outcome: 'failure', exit: 1, raw: 'older', ts: at('2026-08-14T09:00:00') }),
    ], NOW);
    expect(a.byJob.worker.lastRaw).toBe('newer');
  });

  it('does not carry a raw tail from a successful run', () => {
    const a = aggregate([run({ job: 'worker', outcome: 'success', raw: 'should not appear' })], NOW);
    expect(a.byJob.worker.lastRaw).toBeNull();
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

  it('folds per-model cost from usage.models, leaving an unmeasured model null', () => {
    const a = aggregate([
      run({ usage: { models: { opus: { costUsd: 3 }, sonnet: { costUsd: 0.5 } } } }),
      run({ usage: { models: { opus: { costUsd: 1 } } } }),
      run({ usage: { models: { haiku: { in: 10 } } } }), // no costUsd
    ], NOW);
    expect(a.byModel.opus.costUsd).toBeCloseTo(4, 6);
    expect(a.byModel.sonnet.costUsd).toBeCloseTo(0.5, 6);
    expect(a.byModel.haiku.costUsd).toBeNull();
  });

  it('never throws on a malformed usage.models shape', () => {
    expect(() => aggregate([run({ usage: { models: 'nope' } })], NOW)).not.toThrow();
    expect(() => aggregate([run({ usage: { models: ['a'] } })], NOW)).not.toThrow();
    expect(() => aggregate([run({ usage: { models: { opus: 'nope' } } })], NOW)).not.toThrow();
  });

  it('breaks quota skips down per day and counts the two reasons separately', () => {
    const a = aggregate([
      run({ outcome: 'skipped', reason: 'usage-limit', ts: at('2026-08-13T09:00:00') }),
      run({ outcome: 'skipped', reason: 'api-overload', ts: at('2026-08-14T09:00:00') }),
      run({ outcome: 'skipped', reason: 'api-overload', ts: at('2026-08-14T10:00:00') }),
    ], NOW);
    const d13 = a.byDay.find((d) => d.date === '2026-08-13');
    const d14 = a.byDay.find((d) => d.date === '2026-08-14');
    expect(d13).toMatchObject({ usageLimit: 1, apiOverload: 0 });
    expect(d14).toMatchObject({ usageLimit: 0, apiOverload: 2 });
  });

  it('keeps the most recent reset text quoted, by timestamp not input order', () => {
    const a = aggregate([
      { ...run({ outcome: 'skipped', reason: 'usage-limit', ts: at('2026-08-14T09:00:00') }), resetAt: 'newer text' },
      { ...run({ outcome: 'skipped', reason: 'usage-limit', ts: at('2026-08-13T09:00:00') }), resetAt: 'older text' },
    ], NOW);
    expect(a.totals.lastResetAt).toBe('newer text');
  });

  it('leaves lastResetAt null when no skip ever quoted one', () => {
    expect(aggregate([run()], NOW).totals.lastResetAt).toBeNull();
  });

  it('keeps the slowest runs, longest first, capped at 8', () => {
    const many = Array.from({ length: 12 }, (_, i) => run({ job: `j${i}`, durationMs: i * 1000 }));
    const a = aggregate(many, NOW);
    expect(a.slowestRuns).toHaveLength(8);
    expect(a.slowestRuns[0]).toMatchObject({ job: 'j11', durationMs: 11_000 });
    expect(a.slowestRuns[7].durationMs).toBe(4000);
  });

  it('leaves slowestRuns empty when no record carries a numeric durationMs', () => {
    const a = aggregate([{ ts: at('2026-08-14T10:00:00'), job: 'worker', outcome: 'success', exit: 0 }], NOW);
    expect(a.slowestRuns).toEqual([]);
  });

  describe('per-job cap on slowest runs (defect 2)', () => {
    // A chronically slow job (`planner`, in the real render this fixed) took every row
    // of the card, all seven visible ones. The cap must not just shrink that job's
    // count — it must free rows for jobs that would otherwise never show up at all.
    const dominant = (n: number) => Array.from({ length: n }, (_, i) =>
      run({ job: 'planner', durationMs: 900_000 - i * 1000 }));

    it('does not let one job with many slow runs fill the card', () => {
      const a = aggregate([
        ...dominant(10),
        run({ job: 'worker', durationMs: 50_000 }),
        run({ job: 'chat', durationMs: 40_000 }),
      ], NOW);
      const plannerRows = a.slowestRuns.filter((r) => r.job === 'planner');
      expect(plannerRows.length).toBeLessThanOrEqual(2);
      expect(a.slowestRuns.some((r) => r.job === 'worker')).toBe(true);
      expect(a.slowestRuns.some((r) => r.job === 'chat')).toBe(true);
    });

    it('still shows the overall slowest run, even from the capped job', () => {
      const a = aggregate(dominant(10), NOW);
      expect(a.slowestRuns[0]).toMatchObject({ job: 'planner', durationMs: 900_000 });
    });

    it('still shows a job with only a single slow run', () => {
      const a = aggregate([...dominant(10), run({ job: 'lonely', durationMs: 1000 })], NOW);
      expect(a.slowestRuns.some((r) => r.job === 'lonely')).toBe(true);
    });

    it('does not cap jobs that are each already under the per-job limit', () => {
      // Confirms the existing "capped at 8" behaviour survives: with one run per job,
      // the per-job cap never engages and the top 8 by duration still win.
      const many = Array.from({ length: 12 }, (_, i) => run({ job: `j${i}`, durationMs: i * 1000 }));
      const a = aggregate(many, NOW);
      expect(a.slowestRuns).toHaveLength(8);
      expect(a.slowestRuns[0]).toMatchObject({ job: 'j11', durationMs: 11_000 });
    });
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

describe('windowStart', () => {
  it('returns local midnight windowDays - 1 days back', () => {
    // NOW is 2026-08-14T14:32 local; a 7-day window starts 6 days earlier.
    const start = windowStart(NOW, 7);
    expect(start).toBe(new Date(2026, 7, 8, 0, 0, 0, 0).getTime());
  });

  describe('stepping across a DST change (Europe/Berlin) — autumn fall-back', () => {
    withTZ('Europe/Berlin');

    // Berlin falls back on 2026-10-25 (clocks go 03:00 CEST -> 02:00 CET), so that
    // day has 25 real hours. This is the direction that actually breaks a
    // milliseconds-per-day step: stepping +24h in absolute time from local midnight
    // on the 25th lands at 23:00 the SAME day — one date repeats and the next one
    // is skipped, so the day index loses a bucket and a whole day of runs vanishes
    // from the chart while still counting in the totals.
    //
    // The SPRING-forward direction does not expose this: a ms-per-day step from
    // local midnight lands at 01:00 local the NEXT day — still the right calendar
    // date — so a test pinned there passes even on broken (ms-stepping) code. Only
    // the autumn direction proves setDate() is actually doing the work (see B1).
    it('keeps every byDay date distinct, consecutive, and ending on today', () => {
      const now = new Date(2026, 9, 28, 12, 0, 0, 0).getTime(); // 2026-10-28
      const a = aggregate([], now, { windowDays: 7 });
      const dates = a.byDay.map((d) => d.date);

      expect(new Set(dates).size).toBe(7);
      for (let i = 1; i < dates.length; i++) {
        expect(dayNumber(dates[i]) - dayNumber(dates[i - 1])).toBe(1);
      }
      expect(dates[dates.length - 1]).toBe('2026-10-28');
    });
  });
});
