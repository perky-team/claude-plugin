import { fit } from '../ansi.mjs';
import { renderTabBar } from './tabbar.mjs';
import { renderOverview } from './overview.mjs';
import { pshedBody, ptasksBody, pgraphBody, pwikiBody } from './plugins.mjs';

const BODY = {
  'p-shed': pshedBody,
  'p-tasks': ptasksBody,
  'p-graph': pgraphBody,
  'p-wiki': pwikiBody,
};

function footer(state, width) {
  if (state.filterMode) return fit(`/${state.filterDraft}▏  (Enter apply · Esc cancel)`, width);
  const flt = state.filter ? `  filter:${state.filter}` : '';
  const foll = state.follow ? 'follow' : 'paused';
  return fit(`Tab/1-9 tabs · j/k move · / filter · f ${foll} · q/esc quit${flt}`, width);
}

export function render(state, { color = false } = {}) {
  const { width, height } = state;
  const bodyHeight = Math.max(0, height - 2); // tab bar + footer
  const lines = [renderTabBar(state, width, { color })];
  const body = state.tab === 'overview'
    ? renderOverview(state, width, bodyHeight, { color })
    : (BODY[state.tab] ?? renderOverview)(state, width, bodyHeight, { color });
  for (let i = 0; i < bodyHeight; i++) lines.push(body[i] ?? fit('', width));
  lines.push(footer(state, width));
  return lines.slice(0, height);
}
