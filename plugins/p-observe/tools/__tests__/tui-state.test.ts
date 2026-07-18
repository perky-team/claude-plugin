import { describe, expect, it } from 'vitest';
import { buildTabs, initState, ingest } from '../lib/tui/state.mjs';

const ev = (o) => ({ ts: 1, plugin: 'p-shed', kind: 'job.finished', entity: 'x', severity: 'ok', summary: '', data: {}, ...o });

describe('buildTabs', () => {
  it('lists overview + present plugins in fixed order', () => {
    expect(buildTabs({ pshed: {}, wiki: {} })).toEqual(['overview', 'p-shed', 'p-wiki']);
  });
});

describe('ingest badges', () => {
  it('increments badge for non-active plugin tabs and advances seenTs', () => {
    let s = initState({ tabs: ['overview', 'p-shed', 'p-wiki'], width: 80, height: 24 });
    s.tab = 'p-wiki'; // active tab is p-wiki
    s = ingest(s, { events: [ev({ ts: 10 })], status: {}, width: 80, height: 24 });
    expect(s.badges['p-shed']).toBe(1); // p-shed event, p-shed tab inactive
    expect(s.seenTs).toBe(10);
  });
  it('does not double-count events already seen', () => {
    let s = initState({ tabs: ['overview', 'p-shed'], width: 80, height: 24 });
    s.tab = 'overview';
    const e = ev({ ts: 5 });
    s = ingest(s, { events: [e], status: {}, width: 80, height: 24 });
    s = ingest(s, { events: [e], status: {}, width: 80, height: 24 });
    // overview is active -> merged stream shows everything -> no badge accrues
    expect(s.badges['p-shed']).toBe(0);
    expect(s.seenTs).toBe(5);
  });
});
