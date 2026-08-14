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

  it('is not due for a job that has never run, even though isDue would say yes', () => {
    // No lastRun at all: the tick baselines this job on its next tick instead of
    // launching it (tick.mjs). isDue would read the missing lastRun as "24h ago" and
    // say yes for a job this frequent, which is exactly the wrong answer here.
    const jobs = [{ id: 'worker', schedule: '*/15 * * * *', enabled: true }];
    const next = computeNext(jobs, [status({ lastRun: null })], NOW);
    expect(next.worker).toEqual({ at: at('2026-08-14T10:15:00'), due: false });
  });

  it('gives a running job at: null, not a guessed next time', () => {
    // lastRun is stale enough that isDue would say yes, but the job's pidfile is still
    // alive, so the tick's duplicate guard skips the launch (tick.mjs). nextRun has no
    // idea the run is still going, so printing its answer names a launch the guard will
    // just skip — and the guess slides forward on every render, forever. at: null is the
    // honest "don't know", the same bucket paused/disabled jobs get.
    const jobs = [{ id: 'worker', schedule: '0 9 * * *', enabled: true }];
    const next = computeNext(jobs, [status({ lastRun: at('2026-08-13T09:00:00'), running: true })], NOW);
    expect(next.worker).toEqual({ at: null, due: false });
  });

  it('reports the backoff time, not due, when a missed slot meets a future retry', () => {
    // isDue is true (the 09:00 slot was missed) AND retryNotBefore is still in the
    // future: the tick will not launch until the backoff clears, so the retry time
    // must win. This is the only case that tells the retry gate and the isDue gate
    // apart, since every other test has one or the other but never both true.
    const jobs = [{ id: 'worker', schedule: '0 9 * * *', enabled: true }];
    const retryAt = at('2026-08-14T11:00:00');
    const next = computeNext(jobs, [status({ lastRun: at('2026-08-13T09:00:00'), retryNotBefore: retryAt })], NOW);
    expect(next.worker).toEqual({ at: retryAt, due: false });
  });
});
