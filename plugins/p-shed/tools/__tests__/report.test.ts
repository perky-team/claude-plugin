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
