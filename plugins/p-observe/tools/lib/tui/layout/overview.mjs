import { fit } from '../ansi.mjs';
import { formatStatus } from '../../render/status.mjs';
import { formatLine } from '../../render/stream.mjs';

// Shared filter predicate used by overview and per-plugin bodies: case-insensitive
// substring over the rendered plain line (entity + summary + plugin).
export function applyFilter(events, filter) {
  if (!filter) return events;
  const f = filter.toLowerCase();
  return events.filter((e) => `${e.plugin} ${e.entity} ${e.summary}`.toLowerCase().includes(f));
}

export function renderOverview(state, width, height, { color = false } = {}) {
  const lines = [];
  const roll = formatStatus(state.status);
  if (roll) for (const l of roll.split('\n')) lines.push(fit(l, width));
  lines.push(fit('─'.repeat(width), width));
  const streamHeight = Math.max(1, height - lines.length);
  let events = applyFilter(state.events, state.filter);
  if (state.freezeTs != null) events = events.filter((e) => e.ts <= state.freezeTs);
  let stream = events.map((e) => fit(formatLine(e, { color }), width));
  stream = stream.slice(-streamHeight); // tail: newest at the bottom
  for (const l of stream) lines.push(l);
  return lines.slice(0, height);
}
