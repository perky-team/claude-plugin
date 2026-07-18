export function severityFor(kind, data = {}) {
  if (kind === 'job.finished') return (data.timedOut || data.exit !== 0) ? 'error' : 'ok';
  if (kind === 'drift.warn' || kind === 'wiki.conflict') return 'warn';
  if (kind === 'index.refresh' && data.error) return 'error';
  return 'info';
}

export function makeEvent(plugin, kind, entity, summary, data = {}, ts = Date.now()) {
  return { ts, plugin, kind, entity, severity: severityFor(kind, data), summary, data };
}
