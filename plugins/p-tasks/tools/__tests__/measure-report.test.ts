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
  // session it ran. The arm with the problem must be named — and only that
  // arm: checked on the warning line itself, not the whole report, because a
  // two-arm report also carries the always-on `none`-vs-tracker caveat, which
  // legitimately names `none` elsewhere on the page.
  it('does not let a clean arm dilute a capped one', () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => row('none', 1, i + 1, { R1: true })),
      { ...row('ptasks', 1, 1, { R1: true }), hit_cap: true },
    ];
    const out = report(rows);
    const capLine = out.split('\n').find((l) => l.includes('the cap bound'));
    expect(capLine).toContain('`ptasks`');
    expect(capLine).not.toContain('`none`');
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

  // The bug: usage and num_turns were journaled every session, but the table
  // had no column for them, so the tracker's own token cost never showed up
  // in the one place a write-up would be pasted from.
  it('adds a tokens-per-session column, averaging every input count across the arm', () => {
    const rows = [
      { ...row('ptasks', 1, 1, { R1: true }), usage: { input_tokens: 1000 } },
      { ...row('ptasks', 1, 2, { R1: true }), usage: { input_tokens: 2000 } },
    ];
    expect(armCells(report(rows), 'ptasks').at(-1)).toBe('1500');
  });

  // Measured on the first real sessions: `input_tokens` was 18 while the same
  // session read half a million cached tokens. Counting only the first field
  // reports a tracker tax of nearly nothing, whatever the arm actually carried.
  it('counts cached and freshly written context, not only input_tokens', () => {
    const rows = [
      {
        ...row('ptasks', 1, 1, { R1: true }),
        usage: { input_tokens: 18, cache_read_input_tokens: 499_000, cache_creation_input_tokens: 1_000 },
      },
    ];
    expect(armCells(report(rows), 'ptasks').at(-1)).toBe('500018');
  });

  it('shows an em dash for tokens per session when no session in the arm reported usage', () => {
    const rows = [row('none', 1, 1, { R1: true }), row('none', 2, 1, { R1: true })];
    expect(armCells(report(rows), 'none').at(-1)).toBe('—');
  });

  // The bug: the design says plainly that `ptasks` vs `beads` is a clean
  // comparison and either against `none` is coarse, because `none` is missing
  // the rule text as well as the tracker — but the score output, the thing
  // that gets pasted into a write-up, carried no such note.
  it('notes that ptasks-vs-beads is clean and either-vs-none is coarse, once there is more than one arm', () => {
    const rows = [row('none', 1, 1, { R1: true }), row('ptasks', 1, 1, { R1: true })];
    const out = report(rows);
    expect(out).toContain('clean comparison');
    expect(out).toContain('coarse');
  });

  it('does not print the arm-comparison caveat for a single-arm report', () => {
    const rows = [row('none', 1, 1, { R1: true })];
    expect(report(rows)).not.toContain('clean comparison');
  });
});
