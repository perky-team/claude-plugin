import { describe, expect, it } from 'vitest';
import { report } from '../../scripts/measure-tracker/report.mjs';

const row = (arm: string, run: number, session: number, tests: Record<string, boolean>) =>
  ({ arm, run, session, tests, cost_usd: 1, hit_cap: false, error: null,
     changed_lines_from_prev: 10, changed_lines_from_seed: 10 * session });

// Pulls one arm's row out of the table by its leading cell, then splits it
// into trimmed, non-empty cells — so a test can check a specific column
// (e.g. the last one) without depending on the exact wording of the others.
const armCells = (out: string, arm: string) => {
  const line = out.split('\n').find((l) => l.startsWith(`| ${arm} |`));
  if (!line) throw new Error(`no row for arm ${arm} in:\n${out}`);
  return line.split('|').map((c) => c.trim()).filter((c) => c !== '');
};

describe('report', () => {
  it('gives one row per arm', () => {
    const rows = [
      row('none', 1, 1, { R1: true, R2: false }),
      row('ptasks', 1, 1, { R1: true, R2: true }),
    ];
    const out = report(rows);
    expect(out).toContain('| none |');
    expect(out).toContain('| ptasks |');
  });

  // Two runs that disagree completely. A report that printed only the mean
  // would say 0.50 and nothing else; this asserts the range itself, so the
  // test cannot pass on the column header alone.
  it('shows the range across the runs of one arm, not only the mean', () => {
    const rows = [
      row('ptasks', 1, 1, { R1: true, R2: true }),
      row('ptasks', 2, 1, { R1: false, R2: false }),
    ];
    expect(report(rows)).toContain('0.00–1.00');
  });

  it('says plainly when the dollar cap bound too often to trust the numbers', () => {
    const rows = [{ ...row('none', 1, 1, { R1: true }), hit_cap: true }];
    expect(report(rows)).toContain('the cap bound');
  });

  // Twenty clean sessions in one arm and one capped session in another. Pooled,
  // that is 1 in 21 and no warning fires; per arm, the second one capped every
  // session it ran. The arm with the problem must be named.
  it('does not let a clean arm dilute a capped one', () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => row('none', 1, i + 1, { R1: true })),
      { ...row('ptasks', 1, 1, { R1: true }), hit_cap: true },
    ];
    const out = report(rows);
    expect(out).toContain('the cap bound');
    expect(out).toContain('`ptasks`');
    expect(out).not.toContain('`none`');
  });

  it('does not crash on an empty study', () => {
    expect(report([])).toContain('no runs');
  });

  // The bug: the cell printed the mean session only, so an arm finishing 1 of
  // 5 runs at session 3 (barely worked at all) printed the same shape of
  // number as an arm finishing 5 of 5 at session 6 (worked every time, just
  // slower) — and the smaller number read as the win.
  it('prints how many runs finished, next to the mean session, not the mean alone', () => {
    const rows = [
      row('none', 1, 3, { R1: true }),
      row('none', 2, 1, { R1: false }),
      row('none', 3, 1, { R1: false }),
      row('none', 4, 1, { R1: false }),
      row('none', 5, 1, { R1: false }),
    ];
    expect(report(rows)).toContain('3.0 (1/5)');
  });

  it('still says never when no run in the arm ever finished', () => {
    const rows = [row('none', 1, 1, { R1: false })];
    const cells = armCells(report(rows), 'none');
    expect(cells).toContain('never');
  });
});
