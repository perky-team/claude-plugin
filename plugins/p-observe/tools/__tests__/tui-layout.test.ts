import { describe, expect, it } from 'vitest';
import { renderTabBar } from '../lib/tui/layout/tabbar.mjs';
import { renderOverview } from '../lib/tui/layout/overview.mjs';
import { initState } from '../lib/tui/state.mjs';
import { renderMasterDetail } from '../lib/tui/layout/masterdetail.mjs';
import { pshedBody, pgraphBody } from '../lib/tui/layout/plugins.mjs';
import { render } from '../lib/tui/layout/frame.mjs';

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
  it('hides events newer than freezeTs while paused, shows them once resumed', () => {
    const s = initState({ tabs: ['overview'], width: 60, height: 10 });
    const older = Date.parse('2026-07-18T10:00:00Z');
    const newer = Date.parse('2026-07-18T10:05:00Z');
    s.events = [ev({ ts: older, entity: 'daily', summary: 'exit 0' }), ev({ ts: newer, entity: 'lint', summary: 'exit 1' })];
    s.follow = false;
    s.freezeTs = older;
    const paused = renderOverview(s, 60, 10, { color: false }).join('\n');
    expect(paused).toContain('daily');
    expect(paused).not.toContain('lint');
    s.freezeTs = null;
    const resumed = renderOverview(s, 60, 10, { color: false }).join('\n');
    expect(resumed).toContain('lint');
  });
});

describe('renderMasterDetail', () => {
  it('renders list + detail, marks the selected row, clamps selection', () => {
    const out = renderMasterDetail({
      items: ['a', 'b', 'c'], selectedIdx: 99, detailLines: ['detail'], width: 40, height: 5, color: false,
    });
    expect(out).toHaveLength(5);
    expect(out.join('\n')).toContain('c'); // clamp to last
    expect(out.join('\n')).toContain('detail');
    expect(out.some((l) => l.includes('>'))).toBe(true); // cursor marker
  });
});

describe('per-plugin bodies', () => {
  it('pshedBody lists jobs and shows the selected job detail', () => {
    const s = initState({ tabs: ['overview', 'p-shed'], width: 60, height: 8 });
    s.tab = 'p-shed';
    s.status = { pshed: { running: ['build'], jobs: { lint: { lastExit: 1 } } } };
    s.events = [ev({ plugin: 'p-shed', entity: 'lint', severity: 'error', summary: 'exit 1' })];
    const out = pshedBody(s, 60, 8, { color: false });
    expect(out.join('\n')).toContain('lint');
    expect(out.join('\n')).toContain('build');
  });
  it('pgraphBody shows counters and reindex history (no list)', () => {
    const s = initState({ tabs: ['overview', 'p-graph'], width: 60, height: 8 });
    s.tab = 'p-graph';
    s.status = { pgraph: { nodes: 120, drift: 0 } };
    s.events = [ev({ plugin: 'p-graph', entity: '-', summary: '+3 nodes (120 total)' })];
    const out = pgraphBody(s, 60, 8, { color: false });
    expect(out.join('\n')).toContain('120');
    expect(out.join('\n')).toContain('nodes');
  });
});

describe('render (frame)', () => {
  it('produces exactly height lines with tab bar and footer', () => {
    const s = initState({ tabs: ['overview', 'p-shed'], width: 50, height: 12 });
    s.status = { pshed: { running: [], jobs: {} } };
    const out = render(s, { color: false });
    expect(out).toHaveLength(12);
    expect(out[0]).toContain('overview');
    expect(out[11]).toMatch(/q quit|filter/i);
  });
  it('shows the filter prompt in the footer while typing', () => {
    const s = initState({ tabs: ['overview'], width: 50, height: 8 });
    s.filterMode = true; s.filterDraft = 'lin';
    const out = render(s, { color: false });
    expect(out[out.length - 1]).toContain('/lin');
  });
  it('keeps the footer as the last line at minimal height', () => {
    const s = initState({ tabs: ['overview', 'p-shed'], width: 50, height: 2 });
    s.status = { pshed: { running: [], jobs: {} } };
    const out = render(s, { color: false });
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('overview');       // tab bar
    expect(out[1]).toMatch(/q quit|filter/i);   // footer preserved
  });
});
