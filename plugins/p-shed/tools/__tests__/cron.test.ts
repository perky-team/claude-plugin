import { describe, expect, it } from 'vitest';
import { parseCron, matches, isDue, nextRun } from '../lib/cron.mjs';

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi);

describe('parseCron', () => {
  it('rejects non-5-field expressions', () => {
    expect(() => parseCron('* * * *')).toThrow();
  });
  it('rejects out-of-range field values', () => {
    expect(() => parseCron('60 * * * *')).toThrow();
    expect(() => parseCron('* 24 * * *')).toThrow();
  });
  it('still parses valid crons', () => {
    expect(() => parseCron('*/15 * * * *')).not.toThrow();
    expect(() => parseCron('0 9-17 * * *')).not.toThrow();
    expect(() => parseCron('1,3 * * * *')).not.toThrow();
    expect(() => parseCron('0 0 * * *')).not.toThrow();
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

describe('nextRun', () => {
  const at = (iso: string) => new Date(iso).getTime();

  it('finds the next quarter hour', () => {
    const t = nextRun(parseCron('*/15 * * * *'), at('2026-08-14T10:07:30'));
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
});
