import { describe, expect, it } from 'vitest';
import { parseCron, matches, isDue } from '../lib/cron.mjs';

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi);

describe('parseCron', () => {
  it('rejects non-5-field expressions', () => {
    expect(() => parseCron('* * * *')).toThrow();
  });
});

describe('matches', () => {
  it('every minute', () => {
    expect(matches(parseCron('* * * * *'), at(2026, 7, 16, 3, 7))).toBe(true);
  });
  it('specific minute/hour', () => {
    const c = parseCron('30 2 * * *');
    expect(matches(c, at(2026, 7, 16, 2, 30))).toBe(true);
    expect(matches(c, at(2026, 7, 16, 2, 31))).toBe(false);
  });
  it('step values', () => {
    const c = parseCron('*/15 * * * *');
    expect(matches(c, at(2026, 7, 16, 1, 0))).toBe(true);
    expect(matches(c, at(2026, 7, 16, 1, 15))).toBe(true);
    expect(matches(c, at(2026, 7, 16, 1, 7))).toBe(false);
  });
  it('ranges and lists', () => {
    const c = parseCron('0 9-17 * * 1,3', );
    expect(matches(c, at(2026, 7, 13, 9, 0))).toBe(true);   // Monday
    expect(matches(c, at(2026, 7, 14, 9, 0))).toBe(false);  // Tuesday
  });
});

describe('isDue', () => {
  it('true when a matching minute passed since lastRun', () => {
    const c = parseCron('*/15 * * * *');
    const last = at(2026, 7, 16, 1, 5).getTime();
    const now = at(2026, 7, 16, 1, 20).getTime();
    expect(isDue(c, last, now)).toBe(true);   // 1:15 matched
  });
  it('false when no matching minute passed', () => {
    const c = parseCron('*/15 * * * *');
    const last = at(2026, 7, 16, 1, 16).getTime();
    const now = at(2026, 7, 16, 1, 20).getTime();
    expect(isDue(c, last, now)).toBe(false);
  });
  it('collapses several missed matches to a single due signal', () => {
    const c = parseCron('* * * * *');
    const last = at(2026, 7, 16, 1, 0).getTime();
    const now = at(2026, 7, 16, 1, 30).getTime();
    expect(isDue(c, last, now)).toBe(true);   // one boolean, not 30 launches
  });
});
