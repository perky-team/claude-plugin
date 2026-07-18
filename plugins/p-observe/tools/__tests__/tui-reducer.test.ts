import { describe, expect, it } from 'vitest';
import { initState } from '../lib/tui/state.mjs';
import { reduce } from '../lib/tui/reducer.mjs';

function base() {
  const s = initState({ tabs: ['overview', 'p-shed', 'p-wiki'], width: 80, height: 24 });
  s.badges['p-shed'] = 3;
  return s;
}

describe('reduce', () => {
  it('Tab cycles tabs and clears the target badge', () => {
    let s = reduce(base(), 'tab');
    expect(s.tab).toBe('p-shed');
    expect(s.badges['p-shed']).toBe(0);
  });
  it('digit jumps to a tab by 1-based index', () => {
    expect(reduce(base(), 'digit:2').tab).toBe('p-shed');
    expect(reduce(base(), 'digit:9').tab).toBe('overview'); // out of range -> no change
  });
  it('q and ctrl-c quit', () => {
    expect(reduce(base(), 'q').quit).toBe(true);
    expect(reduce(base(), 'ctrl-c').quit).toBe(true);
  });
  it('f toggles follow', () => {
    expect(reduce(base(), 'f').follow).toBe(false);
  });
  it('/ enters filter mode; chars edit draft; enter commits; esc cancels', () => {
    let s = reduce(base(), '/');
    expect(s.filterMode).toBe(true);
    s = reduce(s, 'char:a');
    s = reduce(s, 'j'); // in filter mode j is literal text
    expect(s.filterDraft).toBe('aj');
    s = reduce(s, 'backspace');
    expect(s.filterDraft).toBe('a');
    s = reduce(s, 'enter');
    expect(s.filterMode).toBe(false);
    expect(s.filter).toBe('a');
    s = reduce(reduce(s, '/'), 'esc');
    expect(s.filterMode).toBe(false);
    expect(s.filter).toBe('a'); // unchanged on cancel
  });
  it('j/k move selection on plugin tabs only', () => {
    let s = base(); s.tab = 'p-shed';
    s = reduce(s, 'j');
    expect(s.selection['p-shed']).toBe(1);
    s = reduce(s, 'k'); s = reduce(s, 'k');
    expect(s.selection['p-shed']).toBe(0); // clamped at 0
  });
});
