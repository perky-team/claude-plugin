import { describe, expect, it } from 'vitest';
import { renderTabBar } from '../lib/tui/layout/tabbar.mjs';
import { renderOverview } from '../lib/tui/layout/overview.mjs';
import { initState } from '../lib/tui/state.mjs';

function st() {
  const s = initState({ tabs: ['overview', 'p-shed', 'p-wiki'], width: 60, height: 20 });
  s.badges['p-wiki'] = 2;
  return s;
}

describe('renderTabBar', () => {
  it('brackets the active tab and shows badges on others', () => {
    const bar = renderTabBar(st(), 60, { color: false });
    expect(bar).toContain('[1 overview]'); // active by default
    expect(bar).toContain('2 p-shed');
    expect(bar).toMatch(/p-wiki ●2|●2 p-wiki|p-wiki.*2/);
  });
  it('pads to the given width', () => {
    expect(renderTabBar(st(), 60, { color: false }).length).toBe(60);
  });
});

const ev = (o) => ({ ts: Date.parse('2026-07-18T10:00:00Z'), plugin: 'p-shed', kind: 'job.finished', entity: 'daily', severity: 'ok', summary: 'exit 0', data: {}, ...o });

describe('renderOverview', () => {
  it('shows rollups and the merged stream, height-bounded', () => {
    const s = initState({ tabs: ['overview', 'p-shed'], width: 60, height: 10 });
    s.status = { pshed: { running: [], jobs: { daily: { lastExit: 0 } } } };
    s.events = [ev({ summary: 'exit 0' }), ev({ entity: 'lint', severity: 'error', summary: 'exit 1' })];
    const lines = renderOverview(s, 60, 10, { color: false });
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines.join('\n')).toContain('p-shed');
    expect(lines.join('\n')).toContain('exit 1');
  });
  it('applies the filter to the stream', () => {
    const s = initState({ tabs: ['overview'], width: 60, height: 10 });
    s.events = [ev({ summary: 'exit 0' }), ev({ entity: 'lint', summary: 'exit 1' })];
    s.filter = 'lint';
    const body = renderOverview(s, 60, 10, { color: false }).join('\n');
    expect(body).toContain('lint');
    expect(body).not.toContain('daily');
  });
});
