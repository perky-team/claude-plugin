import { describe, expect, it } from 'vitest';
import { escapeHtml, renderHtml } from '../lib/html.mjs';
import { aggregate } from '../lib/report.mjs';

const NOW = new Date('2026-08-14T14:32:00').getTime();
const at = (iso: string) => new Date(iso).getTime();

const status = (jobs: Record<string, unknown>[]) => ({
  action: 'status', task: 'pshed-1a2b3c4d', installed: true, paused: false, jobs,
});
const job = (over: Record<string, unknown> = {}) => ({
  id: 'worker', enabled: true, running: false, paused: false,
  breakerTripped: false, consecutiveFailures: 0, lastRun: at('2026-08-14T14:00:00'),
  lastExit: 0, ...over,
});
const page = (jobs: Record<string, unknown>[], next: Record<string, unknown> = {}) =>
  renderHtml(status(jobs), aggregate([], NOW), next, NOW);

describe('escapeHtml', () => {
  it('escapes the five characters that break markup', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
  it('survives values that are not strings', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('renderHtml', () => {
  it('produces a complete document naming the task', () => {
    const html = page([job()]);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('pshed-1a2b3c4d');
    expect(html).toContain('worker');
  });

  it('carries no script and loads nothing from the network', () => {
    const html = page([job({ pauseReason: 'x' })]);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });

  it('escapes text that came from outside', () => {
    const html = page([job({ paused: true, pauseOrigin: 'self', pauseReason: '<script>alert(1)</script>' })]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('counts a breaker, a self-pause and a retry as problems', () => {
    const html = page([
      job({ id: 'a', breakerTripped: true }),
      job({ id: 'b', paused: true, pauseOrigin: 'self' }),
      job({ id: 'c', lastSkipReason: 'api-overload', retryNotBefore: at('2026-08-14T15:00:00') }),
    ]);
    expect(html).toContain('3 problems');
  });

  it('does not count an operator pause as a problem', () => {
    const html = page([job({ paused: true, pauseOrigin: 'operator', pauseReason: 'holding' })]);
    expect(html).toContain('0 problems');
  });

  it('gives self-pause and operator-pause different badges', () => {
    const self = page([job({ paused: true, pauseOrigin: 'self', pauseReason: 'verify went red' })]);
    const operator = page([job({ paused: true, pauseOrigin: 'operator', pauseReason: 'holding' })]);
    expect(self).toContain('badge-self-pause');
    expect(operator).toContain('badge-held');
  });

  it('renders the next run as a time, as due, and as a dash', () => {
    const html = page(
      [job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })],
      { a: { at: at('2026-08-14T15:00:00'), due: false }, b: { at: null, due: true }, c: { at: null, due: false } },
    );
    expect(html).toContain('15:00');
    expect(html).toContain('>due<');
    expect(html).toContain('>—<');
  });

  it('shows a run cost of an unmeasured window as a dash, not as zero', () => {
    expect(page([job()])).not.toContain('$0.00');
  });

  it('defines both colour schemes', () => {
    const html = page([job()]);
    expect(html).toContain('#2a78d6');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('#3987e5');
  });

  it('puts a table view behind details for the daily chart', () => {
    expect(page([job()])).toContain('<details class="table-view"');
  });

  it('shows the generated time', () => {
    expect(page([job()])).toContain('14:32');
  });
});
