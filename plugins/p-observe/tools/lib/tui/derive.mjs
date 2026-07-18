export function eventsFor(events, plugin) {
  return events.filter((e) => e.plugin === plugin);
}

// p-shed: union of jobs seen in the log and jobs in status(); sort failed, then
// running, then the rest (stable within each group, alphabetical).
export function jobsList(events, status) {
  const s = status.pshed ?? {};
  const running = new Set(s.running ?? []);
  const jobsMeta = s.jobs ?? {};
  const ids = new Set([...Object.keys(jobsMeta), ...running]);
  for (const e of events) if (e.plugin === 'p-shed' && e.entity !== '-') ids.add(e.entity);
  const list = [...ids].sort().map((id) => ({
    id,
    running: running.has(id),
    lastExit: jobsMeta[id]?.lastExit,
    count: events.filter((e) => e.plugin === 'p-shed' && e.entity === id).length,
  }));
  const rank = (j) => (j.lastExit != null && j.lastExit !== 0 ? 0 : j.running ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b));
}

export function tasksList(events) {
  const map = new Map(); // id -> { id, status, history }
  for (const e of eventsFor(events, 'p-tasks')) {
    if (e.entity === '-') continue;
    let t = map.get(e.entity);
    if (!t) { t = { id: e.entity, status: '?', history: [] }; map.set(e.entity, t); }
    t.history.push({ ts: e.ts, summary: e.summary });
    if (e.kind === 'task.added' && e.data?.status) t.status = e.data.status;
    if (e.kind === 'task.status' && e.data?.to) t.status = e.data.to;
    if (e.kind === 'task.removed') t.status = 'removed';
  }
  return [...map.values()];
}

export function pagesList(events) {
  const map = new Map(); // id -> { id, conflict, count, lastSummary }
  for (const e of eventsFor(events, 'p-wiki')) {
    if (e.entity === '-') continue;
    let p = map.get(e.entity);
    if (!p) { p = { id: e.entity, conflict: false, count: 0, lastSummary: '' }; map.set(e.entity, p); }
    p.count++;
    p.lastSummary = e.summary;
    if (e.kind === 'wiki.conflict') p.conflict = true;
    if (e.kind === 'page.removed') p.conflict = false;
  }
  return [...map.values()];
}

export function graphHistory(events) {
  return eventsFor(events, 'p-graph').map((e) => ({ ts: e.ts, summary: e.summary, severity: e.severity }));
}
