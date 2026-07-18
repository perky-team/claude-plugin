import { describe, expect, it } from 'vitest';
import { renderTabBar } from '../lib/tui/layout/tabbar.mjs';
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
