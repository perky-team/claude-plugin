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
