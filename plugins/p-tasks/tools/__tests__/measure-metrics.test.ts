import { describe, expect, it } from 'vitest';
import { done, sessionsToDone, regressionRate, churn, capShare }
  from '../../scripts/measure-tracker/metrics.mjs';

const row = (session: number, tests: Record<string, boolean> | null, extra = {}) =>
  ({ session, tests, cost_usd: 0.1, hit_cap: false, error: null,
     changed_lines_from_prev: 10, changed_lines_from_seed: 10 * session, ...extra });

describe('done', () => {
  it('is the share green in the last scored session', () => {
    expect(done([row(1, { R1: true, R2: false }), row(2, { R1: true, R2: true })])).toBe(1);
  });

  it('ignores sessions that never scored', () => {
    expect(done([row(1, { R1: true, R2: false }), row(2, null)])).toBe(0.5);
  });

  it('is null when nothing scored at all', () => {
    expect(done([row(1, null)])).toBeNull();
  });
});

describe('sessionsToDone', () => {
  it('is the first session where everything is green', () => {
    expect(sessionsToDone([row(1, { R1: false }), row(2, { R1: true }), row(3, { R1: true })]))
      .toBe(2);
  });

  it('is null when it never finished', () => {
    expect(sessionsToDone([row(1, { R1: false })])).toBeNull();
  });
});

describe('regressionRate', () => {
  it('counts green turning red, per hand-over', () => {
    const rows = [row(1, { R1: true, R2: true }), row(2, { R1: false, R2: true }),
      row(3, { R1: false, R2: false })];
    expect(regressionRate(rows)).toBeCloseTo(1);       // two regressions, two hand-overs
  });

  it('does not count red turning green', () => {
    expect(regressionRate([row(1, { R1: false }), row(2, { R1: true })])).toBe(0);
  });

  it('is null with fewer than two scored sessions', () => {
    expect(regressionRate([row(1, { R1: true })])).toBeNull();
  });

  it('is null when no two neighbouring sessions both scored', () => {
    // Two scored sessions, but not next to each other: there is no hand-over to
    // read. Unknown, not zero — a zero would enter the arm's mean as measured
    // evidence that nothing broke.
    const rows = [row(1, { R1: true }), row(2, null), row(3, { R1: false })];
    expect(regressionRate(rows)).toBeNull();
  });

  // The bug: an errored session is scored anyway, and its `tests` map is just
  // whatever the tree already looked like — carried over, not evidence of
  // anything. Counting the pairs on either side of it as hand-overs pads the
  // denominator with hand-overs that never happened, and always pulls the
  // rate down. Two errored sessions between good ones must not do that: with
  // the fix, the only pair left is the one where two working sessions really
  // did hand over to each other, and the rate reads off that pair alone.
  it('does not count a hand-over across an errored session, so a real regression is not diluted', () => {
    const rows = [
      row(1, { R1: true }),
      { ...row(2, { R1: true }), error: 'boom' },
      { ...row(3, { R1: true }), error: 'boom' },
      row(4, { R1: true }),
      row(5, { R1: false }),
    ];
    // Buggy code counts all 4 adjacent pairs as hand-overs (rate 1/4 = 0.25).
    // Fixed code counts only session 4 → 5, the one pair with no error on
    // either side, where the regression is real.
    expect(regressionRate(rows)).toBe(1);
  });
});

describe('churn', () => {
  it('is one when every line was written once', () => {
    const rows = [row(1, { R1: true }, { changed_lines_from_prev: 30, changed_lines_from_seed: 30 })];
    expect(churn(rows)).toBe(1);
  });

  it('is three when the same lines were rewritten three times', () => {
    const rows = [
      row(1, { R1: true }, { changed_lines_from_prev: 30, changed_lines_from_seed: 30 }),
      row(2, { R1: true }, { changed_lines_from_prev: 30, changed_lines_from_seed: 30 }),
      row(3, { R1: true }, { changed_lines_from_prev: 30, changed_lines_from_seed: 30 }),
    ];
    expect(churn(rows)).toBe(3);
  });

  it('is null when the run changed nothing', () => {
    expect(churn([row(1, null, { changed_lines_from_prev: 0, changed_lines_from_seed: 0 })]))
      .toBeNull();
  });
});

describe('capShare', () => {
  it('is the share of sessions that hit the dollar cap', () => {
    expect(capShare([row(1, null), row(2, null, { hit_cap: true })])).toBe(0.5);
  });
});
