import { fit } from '../ansi.mjs';

export function renderTabBar(state, width, { color = false } = {}) {
  const parts = state.tabs.map((id, i) => {
    const n = i + 1;
    const badge = state.badges[id] > 0 ? ` ●${state.badges[id]}` : '';
    const label = `${n} ${id}${badge}`;
    if (id === state.tab) return color ? `\x1b[7m[${label}]\x1b[0m` : `[${label}]`;
    return ` ${label} `;
  });
  return fit(parts.join(' '), width);
}
