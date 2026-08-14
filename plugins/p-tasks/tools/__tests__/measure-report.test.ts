import { describe, expect, it } from 'vitest';
import { report } from '../../scripts/measure-tracker/report.mjs';

const row = (arm: string, run: number, session: number, tests: Record<string, boolean>) =>
  ({ arm, run, session, tests, cost_usd: 1, hit_cap: false, error: null,
     changed_lines_from_prev: 10, changed_lines_from_seed: 10 * session });

describe('report', () => {
  it('gives one row per arm with the spread, not only the mean', () => {
    const rows = [
      row('none', 1, 1, { R1: true, R2: false }),
      row('ptasks', 1, 1, { R1: true, R2: true }),
    ];
    const out = report(rows);
    expect(out).toContain('| none |');
    expect(out).toContain('| ptasks |');
    expect(out).toContain('spread');
  });

  it('says plainly when the dollar cap bound too often to trust the numbers', () => {
    const rows = [{ ...row('none', 1, 1, { R1: true }), hit_cap: true }];
    expect(report(rows)).toContain('the cap bound');
  });

  it('does not crash on an empty study', () => {
    expect(report([])).toContain('no runs');
  });
});
