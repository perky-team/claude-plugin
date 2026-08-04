export function severityFor(kind, data = {}) {
  if (kind === 'job.finished') return (data.timedOut || data.exit !== 0) ? 'error' : 'ok';
  // A reclaim means a `deploy` died holding the loop paused — recovered automatically,
  // but worth a human's attention, not routine 'info' noise.
  if (kind === 'drift.warn' || kind === 'wiki.conflict' || kind === 'deploy.reclaimed') return 'warn';
  if (kind === 'index.refresh' && data.error) return 'error';
  return 'info';
}

export function makeEvent(plugin, kind, entity, summary, data = {}, ts = Date.now()) {
  return { ts, plugin, kind, entity, severity: severityFor(kind, data), summary, data };
}
