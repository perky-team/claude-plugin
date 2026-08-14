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

  it('leaves a 2px gap between neighbouring bars', () => {
    const svg = barsByDay(days([1, 1]), opts);
    const xs = [...svg.matchAll(/data-x="([\d.]+)" data-w="([\d.]+)"/g)]
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

  it('returns an empty state when every day is zero', () => {
    expect(barsByDay(days([null, null]), opts)).toContain('no runs yet');
  });

  it('labels the first and last day only', () => {
    const svg = barsByDay(days([1, 2, 3]), opts);
    expect(svg).toContain('>08-01<');
    expect(svg).toContain('>08-03<');
    expect(svg).not.toContain('>08-02<');
  });
});
