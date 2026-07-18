import { fit } from '../ansi.mjs';
import { formatLine } from '../../render/stream.mjs';
import { renderMasterDetail, clampIdx } from './masterdetail.mjs';
import { jobsList, tasksList, pagesList, graphHistory, eventsFor } from '../derive.mjs';

function jobLabel(j) {
  const tag = j.running ? '⟳' : j.lastExit != null && j.lastExit !== 0 ? '✗' : '·';
  return `${tag} ${j.id}`;
}

export function pshedBody(state, width, height, { color = false } = {}) {
  const jobs = applyFilterList(jobsList(state.events, state.status), state.filter, (j) => j.id);
  const sel = clampIdx(state.selection['p-shed'] ?? 0, jobs.length);
  const chosen = jobs[sel];
  const detail = [];
  if (chosen) {
    detail.push(fit(`job: ${chosen.id}`, width));
    detail.push(fit(`state: ${chosen.running ? 'running' : chosen.lastExit != null ? 'exit ' + chosen.lastExit : '—'}`, width));
    detail.push('');
    for (const e of eventsFor(state.events, 'p-shed').filter((e) => e.entity === chosen.id))
      detail.push(formatLine(e, { color }));
  }
  return renderMasterDetail({ items: jobs.map(jobLabel), selectedIdx: sel, detailLines: detail, width, height, color });
}

export function ptasksBody(state, width, height, { color = false } = {}) {
  const tasks = applyFilterList(tasksList(state.events), state.filter, (t) => t.id + ' ' + t.status);
  const sel = clampIdx(state.selection['p-tasks'] ?? 0, tasks.length);
  const chosen = tasks[sel];
  const detail = [];
  if (chosen) {
    detail.push(fit(`task: ${chosen.id}  [${chosen.status}]`, width));
    detail.push('');
    for (const h of chosen.history) detail.push(fit(`  ${h.summary}`, width));
  }
  return renderMasterDetail({ items: tasks.map((t) => `${t.id} (${t.status})`), selectedIdx: sel, detailLines: detail, width, height, color });
}

export function pwikiBody(state, width, height, { color = false } = {}) {
  const pages = applyFilterList(pagesList(state.events), state.filter, (p) => p.id);
  const sel = clampIdx(state.selection['p-wiki'] ?? 0, pages.length);
  const chosen = pages[sel];
  const detail = [];
  if (chosen) {
    detail.push(fit(`page: ${chosen.id}${chosen.conflict ? '  ⚠ conflict' : ''}`, width));
    detail.push('');
    for (const e of eventsFor(state.events, 'p-wiki').filter((e) => e.entity === chosen.id))
      detail.push(formatLine(e, { color }));
  }
  return renderMasterDetail({ items: pages.map((p) => (p.conflict ? '⚠ ' : '  ') + p.id), selectedIdx: sel, detailLines: detail, width, height, color });
}

// p-graph is single-entity: no master list, just counters + reindex history.
export function pgraphBody(state, width, height, { color = false } = {}) {
  const g = state.status.pgraph ?? {};
  const lines = [];
  lines.push(fit(`nodes ${g.nodes ?? '?'} · edges ${g.edges ?? '?'} · files ${g.files ?? '?'} · drift ${g.drift ?? '?'}`, width));
  lines.push(fit('─'.repeat(width), width));
  const hist = applyFilterList(graphHistory(state.events), state.filter, (h) => h.summary);
  for (const h of hist.slice(-(height - 2))) lines.push(fit(`  ${h.summary}`, width));
  return lines.slice(0, height);
}

function applyFilterList(items, filter, textOf) {
  if (!filter) return items;
  const f = filter.toLowerCase();
  return items.filter((it) => textOf(it).toLowerCase().includes(f));
}
