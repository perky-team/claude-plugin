function switchTab(state, id) {
  if (!state.tabs.includes(id)) return state;
  const badges = { ...state.badges };
  if (badges[id] != null) badges[id] = 0;
  return { ...state, tab: id, badges };
}

function moveSelection(state, delta) {
  if (state.tab === 'overview') return state;
  const cur = state.selection[state.tab] ?? 0;
  const next = Math.max(0, cur + delta); // upper bound is clamped at render time against list length
  return { ...state, selection: { ...state.selection, [state.tab]: next } };
}

export function reduce(state, token) {
  if (state.filterMode) {
    if (token === 'ctrl-c') return { ...state, quit: true };
    if (token === 'enter') return { ...state, filterMode: false, filter: state.filterDraft };
    if (token === 'esc') return { ...state, filterMode: false, filterDraft: state.filter };
    if (token === 'backspace') return { ...state, filterDraft: state.filterDraft.slice(0, -1) };
    if (token.startsWith('char:')) return { ...state, filterDraft: state.filterDraft + token.slice(5) };
    if (token.startsWith('digit:')) return { ...state, filterDraft: state.filterDraft + token.slice(6) };
    // bare j/k/f/q// are literal text while typing a filter
    if (['j', 'k', 'f', 'q', '/'].includes(token)) return { ...state, filterDraft: state.filterDraft + token };
    return state;
  }
  if (token === 'q' || token === 'ctrl-c') return { ...state, quit: true };
  if (token === 'tab') {
    const i = state.tabs.indexOf(state.tab);
    return switchTab(state, state.tabs[(i + 1) % state.tabs.length]);
  }
  if (token.startsWith('digit:')) {
    const idx = Number(token.slice(6)) - 1;
    return idx >= 0 && idx < state.tabs.length ? switchTab(state, state.tabs[idx]) : state;
  }
  if (token === 'f') {
    const follow = !state.follow;
    return { ...state, follow, freezeTs: follow ? null : state.seenTs };
  }
  if (token === '/') return { ...state, filterMode: true, filterDraft: state.filter };
  if (token === 'j' || token === 'down') return moveSelection(state, +1);
  if (token === 'k' || token === 'up') return moveSelection(state, -1);
  return state;
}
