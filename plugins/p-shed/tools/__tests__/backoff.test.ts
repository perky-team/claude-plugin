// When may a job that was skipped for quota/overload try again?
//
// The scheduling half of "a quota skip does not consume the slot": the job stays due, so
// something has to stop a minutely job from relaunching `claude -p` every 60 s for the
// whole five-hour window. That bound is computeRetryAt, and the reset time a limit
// message sometimes carries is the shortcut past it.
//
// A wrong reset time is deliberately harmless: too early only produces another skip and a
// longer backoff, too late is capped. That is what makes parsing free text acceptable
// here at all — see the design note in docs/superpowers/specs/2026-08-04-pshed-skip-retry-design.md.

import { describe, expect, it } from 'vitest';
import { computeRetryAt, SKIP_BACKOFF_BASE_MS, SKIP_BACKOFF_MAX_MS } from '../lib/backoff.mjs';
import { parseResetTime } from '../lib/classify.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 7, 4, 9, 5).getTime(); // 2026-08-04 09:05 local

describe('computeRetryAt — bounded backoff', () => {
  it('doubles from one minute and stops at the cap', () => {
    const at = (n: number) => computeRetryAt({ now: NOW, consecutiveSkips: n }) - NOW;
    expect(at(1)).toBe(1 * MIN);
    expect(at(2)).toBe(2 * MIN);
    expect(at(3)).toBe(4 * MIN);
    expect(at(4)).toBe(8 * MIN);
    expect(at(5)).toBe(16 * MIN);
    expect(at(6)).toBe(SKIP_BACKOFF_MAX_MS);   // 32 min would exceed the cap
    expect(at(50)).toBe(SKIP_BACKOFF_MAX_MS);  // and never grows past it
  });

  it('never returns a moment in the past, whatever it is handed', () => {
    for (const skips of [0, 1, 9]) {
      for (const resetAtMs of [undefined, NOW - HOUR, NOW]) {
        expect(computeRetryAt({ now: NOW, consecutiveSkips: skips, resetAtMs })).toBeGreaterThan(NOW);
      }
    }
  });

  it('a first skip with no reset time waits one tick, not zero', () => {
    expect(computeRetryAt({ now: NOW, consecutiveSkips: 1 })).toBe(NOW + SKIP_BACKOFF_BASE_MS);
    // consecutiveSkips is 1-based; a defensive 0 must not produce a sub-minute retry.
    expect(computeRetryAt({ now: NOW, consecutiveSkips: 0 })).toBe(NOW + SKIP_BACKOFF_BASE_MS);
  });

  it('a known reset time wins over the backoff, in both directions', () => {
    // Further away than the backoff: wait for the quota, not for the exponent.
    expect(computeRetryAt({ now: NOW, consecutiveSkips: 1, resetAtMs: NOW + 5 * HOUR })).toBe(NOW + 5 * HOUR);
    // Closer than the backoff: the quota is back, so do not sit out the exponent.
    expect(computeRetryAt({ now: NOW, consecutiveSkips: 9, resetAtMs: NOW + 3 * MIN })).toBe(NOW + 3 * MIN);
  });

  it('a reset time in the past or right now degrades to the ordinary backoff floor', () => {
    expect(computeRetryAt({ now: NOW, consecutiveSkips: 1, resetAtMs: NOW - HOUR })).toBe(NOW + SKIP_BACKOFF_BASE_MS);
    expect(computeRetryAt({ now: NOW, consecutiveSkips: 1, resetAtMs: NOW })).toBe(NOW + SKIP_BACKOFF_BASE_MS);
  });

  it('clamps an absurd reset time to 24h so a bad parse cannot pin the job open', () => {
    expect(computeRetryAt({ now: NOW, consecutiveSkips: 1, resetAtMs: NOW + 400 * HOUR })).toBe(NOW + 24 * HOUR);
  });
});

describe('parseResetTime — free text to a timestamp', () => {
  const at = (out: string) => parseResetTime(out, '', NOW);

  it('reads a 12-hour time and resolves it to the next occurrence', () => {
    // 3am is before 09:05, so it means tomorrow.
    expect(at('5-hour limit reached ∙ resets 3am')).toBe(new Date(2026, 7, 5, 3, 0).getTime());
    // 11am is still ahead today.
    expect(at('usage limit reached ∙ resets 11am')).toBe(new Date(2026, 7, 4, 11, 0).getTime());
    expect(at('resets 3:30pm')).toBe(new Date(2026, 7, 4, 15, 30).getTime());
    expect(at('resets 12am')).toBe(new Date(2026, 7, 5, 0, 0).getTime());
    expect(at('resets 12pm')).toBe(new Date(2026, 7, 4, 12, 0).getTime());
  });

  it('reads a 24-hour time', () => {
    expect(at('reset at 15:00')).toBe(new Date(2026, 7, 4, 15, 0).getTime());
    expect(at('reset at 07:30')).toBe(new Date(2026, 7, 5, 7, 30).getTime()); // already past today
  });

  it('reads a full date, which a bare time regex would misread as today', () => {
    const iso = new Date(2026, 7, 4, 22, 15).toISOString();
    expect(at(`resets ${iso}`)).toBe(new Date(2026, 7, 4, 22, 15).getTime());
  });

  it('survives a timezone suffix by falling through to the time-of-day form', () => {
    expect(at('resets 3am (Europe/Moscow)')).toBe(new Date(2026, 7, 5, 3, 0).getTime());
  });

  it('returns undefined when there is nothing usable, so the caller backs off instead', () => {
    expect(at('Claude usage limit reached')).toBeUndefined();
    expect(at('resets soon')).toBeUndefined();
    expect(at('')).toBeUndefined();
    // A bare number must not be handed to Date.parse and believed: V8 reads "3" as a
    // year. The (now, now+48h] window is what rejects it.
    expect(at('resets 3')).toBeUndefined();
  });

  it('rejects a parsed date outside the next 48 hours', () => {
    expect(at('resets 2019-01-02T03:04:05Z')).toBeUndefined();
    expect(at('resets 2099-01-02T03:04:05Z')).toBeUndefined();
  });

  it('reads stderr as well as stdout, like every other classifier here', () => {
    expect(parseResetTime('', 'limit ∙ resets 11am', NOW)).toBe(new Date(2026, 7, 4, 11, 0).getTime());
  });
});
