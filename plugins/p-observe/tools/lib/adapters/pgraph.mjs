import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { makeEvent } from '../event.mjs';
import { watchPath } from '../watch.mjs';

function defaultRunStatus(cfg) {
  return () => {
    if (!cfg.pgraphCli) return null;
    try {
      const out = execFileSync(cfg.nodeBin, [cfg.pgraphCli, 'status', '--json'], { encoding: 'utf-8' });
      return JSON.parse(out);
    } catch { return null; }
  };
}

export function createPgraphAdapter({ paths, cfg, emit, runStatus }) {
  const status = runStatus ?? defaultRunStatus(cfg);
  let last = null; // last counts
  let watcher = null;

  function onChange() {
    const s = status();
    if (!s) { emit(makeEvent('p-graph', 'index.refresh', '-', 'db changed', { error: !cfg.pgraphCli ? undefined : true })); return; }
    const d = last ? (s.nodes - last.nodes) : 0;
    const sign = d >= 0 ? `+${d}` : `${d}`;
    const summary = last ? `${sign} nodes (${s.nodes} total)` : `${s.nodes} nodes indexed`;
    emit(makeEvent('p-graph', 'index.refresh', '-', summary, s));
    if (s.drift > 0) emit(makeEvent('p-graph', 'drift.warn', '-', `drift ${s.drift} files`, s));
    last = s;
  }

  return {
    _onChange: onChange, // test seam
    backfill() { const s = status(); if (s) last = s; },
    start() { if (existsSync(dirname(paths.graphDb))) watcher = watchPath(dirname(paths.graphDb), onChange); },
    stop() { if (watcher) watcher.close(); watcher = null; },
    status() { return last ?? {}; },
  };
}
