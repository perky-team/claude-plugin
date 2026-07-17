import { describe, expect, it } from 'vitest';
import { formatLine } from '../lib/render/stream.mjs';
import { formatStatus } from '../lib/render/status.mjs';

const ev = { ts: Date.parse('2026-07-17T14:03:54Z'), plugin: 'p-shed', kind: 'job.finished', entity: 'daily', severity: 'ok', summary: 'exit 0 (42s)', data: {} };

describe('formatLine', () => {
  it('renders time, plugin, glyph, summary (plain)', () => {
    const line = formatLine(ev, { color: false });
    expect(line).toContain('p-shed');
    expect(line).toContain('exit 0 (42s)');
    expect(line).toMatch(/\d\d:\d\d:\d\d/);
  });
  it('has no ANSI escapes when color is false', () => {
    expect(formatLine(ev, { color: false })).not.toMatch(/\[/);
  });
});

describe('formatStatus', () => {
  it('summarizes present adapters and omits absent ones', () => {
    const out = formatStatus({
      pshed: { running: ['daily'], jobs: { daily: { lastExit: 0 }, lint: { lastExit: 1 } } },
      ptasks: { counts: { todo: 3, in_progress: 1 } },
    });
    expect(out).toMatch(/p-shed/);
    expect(out).toMatch(/running/);
    expect(out).toMatch(/p-tasks/);
    expect(out).not.toMatch(/p-graph/);
  });
});
