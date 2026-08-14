import { describe, expect, it } from 'vitest';
import { barsByDay } from '../lib/charts.mjs';

const opts = { width: 320, height: 96, series: '#2a78d6', muted: '#898781', grid: '#e1e0d9' };
const days = (costs: (number | null)[]) =>
  costs.map((c, i) => ({ date: `2026-08-0${i + 1}`, costUsd: c, runs: c === null ? 0 : 1 }));

describe('barsByDay', () => {
  it('draws one bar per day with a value', () => {
    const svg = barsByDay(days([1, 2, 3]), opts);
    expect((svg.match(/<path class="bar"/g) ?? []).length).toBe(3);
  });

  it('draws no bar for a day with no measured cost', () => {
    const svg = barsByDay(days([1, null, 3]), opts);
    expect((svg.match(/<path class="bar"/g) ?? []).length).toBe(2);
  });

  it('gives the tallest bar the full plot height', () => {
    const svg = barsByDay(days([1, 4]), opts);
    // height 96 - padTop 12 - axis band 14 = 70
    expect(svg).toContain('data-h="70"');
  });

  it('anchors bars on the baseline, not the top', () => {
    // Regression guard: a bar drawn from the top with the same height would pass
    // every test above (same data-h, same data-w, same data-x) and only show up here.
    const svg = barsByDay(days([1, 4]), opts);
    const dataYs = [...svg.matchAll(/data-y="([\d.]+)"/g)].map((m) => Number(m[1]));
    // The tallest bar (cost 4) fills the whole plot, so its top edge sits at the
    // plot's top edge: padTop (12).
    expect(dataYs[1]).toBeCloseTo(12, 5);
    // The short bar (cost 1) is far shorter, so its top edge sits well below the
    // tall bar's — near the baseline, not near the top.
    expect(dataYs[0]).toBeGreaterThan(dataYs[1] + 40);
  });

  it('leaves a 2px gap between neighbouring bars', () => {
    const svg = barsByDay(days([1, 1]), opts);
    const xs = [...svg.matchAll(/data-x="([\d.]+)" data-y="[\d.]+" data-w="([\d.]+)"/g)]
      .map((m) => ({ x: Number(m[1]), w: Number(m[2]) }));
    expect(xs[1].x - (xs[0].x + xs[0].w)).toBeCloseTo(2, 5);
  });

  it('sizes the viewBox to include the axis band', () => {
    expect(barsByDay(days([1]), opts)).toContain('viewBox="0 0 320 96"');
  });

  it('returns an empty state rather than a broken box for no data', () => {
    const svg = barsByDay([], opts);
    expect(svg).toContain('no runs yet');
    expect(svg).not.toContain('<path class="bar"');
  });

  it('returns an empty state when every day is null', () => {
    expect(barsByDay(days([null, null]), opts)).toContain('no runs yet');
  });

  it('returns a "no cost recorded" empty state when every day cost exactly zero', () => {
    // costUsd 0 with runs > 0 means real runs that happened to cost nothing —
    // different from null (never measured), and must not say "no runs yet".
    const byDay = [
      { date: '2026-08-01', costUsd: 0, runs: 1 },
      { date: '2026-08-02', costUsd: 0, runs: 3 },
    ];
    const svg = barsByDay(byDay, opts);
    expect(svg).toContain('no cost recorded');
    expect(svg).not.toContain('no runs yet');
    expect(svg).not.toContain('<path class="bar"');
  });

  it('ignores a non-finite cost instead of producing malformed output', () => {
    const byDay = [
      { date: '2026-08-01', costUsd: 1, runs: 1 },
      { date: '2026-08-02', costUsd: NaN, runs: 1 },
      { date: '2026-08-03', costUsd: 3, runs: 1 },
    ];
    const svg = barsByDay(byDay, opts);
    expect(svg).not.toMatch(/NaN/);
    expect((svg.match(/<path class="bar"/g) ?? []).length).toBe(2);
  });

  it('does not throw when opts is omitted', () => {
    expect(() => barsByDay(days([1, 2]))).not.toThrow();
  });

  it('floors the plot height at zero when height is smaller than the padding and axis band', () => {
    const svg = barsByDay(days([1, 2]), { ...opts, height: 10 });
    expect(svg).not.toMatch(/NaN/);
    expect(svg).not.toMatch(/data-h="-/);
  });

  it('labels the first and last day only', () => {
    const svg = barsByDay(days([1, 2, 3]), opts);
    expect(svg).toContain('>08-01<');
    expect(svg).toContain('>08-03<');
    expect(svg).not.toContain('>08-02<');
  });
});
