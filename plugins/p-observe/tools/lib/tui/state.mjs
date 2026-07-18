export const PLUGIN_TABS = [
  { key: 'pshed', id: 'p-shed' },
  { key: 'ptasks', id: 'p-tasks' },
  { key: 'pgraph', id: 'p-graph' },
  { key: 'wiki', id: 'p-wiki' },
];

export function buildTabs(adapters) {
  const present = PLUGIN_TABS.filter((t) => adapters[t.key]).map((t) => t.id);
  return ['overview', ...present];
}

export function initState({ tabs, width = 80, height = 24 }) {
  return {
    tabs,
    tab: tabs[0] ?? 'overview',
    events: [],
    status: {},
    selection: {},
    filter: '',
    filterMode: false,
    filterDraft: '',
    follow: true,
    badges: { 'p-shed': 0, 'p-tasks': 0, 'p-graph': 0, 'p-wiki': 0 },
    seenTs: 0,
    width,
    height,
    quit: false,
  };
}

// Fold the latest bus snapshot + status + terminal size into state. Events newer
// than seenTs that belong to a plugin whose tab is NOT currently active bump that
// plugin's badge; Overview counts as "showing everything" and clears all badges.
export function ingest(state, { events, status, width, height }) {
  const badges = { ...state.badges };
  let maxTs = state.seenTs;
  if (state.tab === 'overview') {
    for (const k of Object.keys(badges)) badges[k] = 0;
  }
  for (const e of events) {
    if (e.ts <= state.seenTs) continue;
    if (e.ts > maxTs) maxTs = e.ts;
    if (state.tab !== 'overview' && e.plugin !== state.tab && badges[e.plugin] != null) {
      badges[e.plugin] += 1;
    }
  }
  return { ...state, events, status, width, height, badges, seenTs: maxTs };
}
