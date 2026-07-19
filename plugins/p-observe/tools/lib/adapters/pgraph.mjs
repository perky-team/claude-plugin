import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { makeEvent } from '../event.mjs';
import { watchPath } from '../watch.mjs';

// Build the `pgraph status` invocation with auto-refresh disabled (both the env
// opt-out and --stale-ok). p-graph auto-refreshes its index on every query, which
// WRITES .pgraph/graph.db; our own fs.watch would then see that write and re-poll in
// a tight loop. p-observe is strictly read-only, so the status read must never mutate.
export function buildStatusCommand(cfg) {
  return {
    file: cfg.nodeBin,
    args: [cfg.pgraphCli, 'status', '--json', '--stale-ok'],
    options: {
      encoding: 'utf-8',
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PGRAPH_AUTOREFRESH: '0' },
    },
  };
}

function defaultRunStatus(cfg) {
  return () => {
    if (!cfg.pgraphCli) return null;
    try {
      const { file, args, options } = buildStatusCommand(cfg);
      return JSON.parse(execFileSync(file, args, options));
    } catch { return null; }
  };
}

export function createPgraphAdapter({ paths, cfg, emit, runStatus }) {
  const status = runStatus ?? defaultRunStatus(cfg);
  let last = null;      // last successful counts snapshot
  let errored = false;  // currently in the degraded/no-status state
  let watcher = null;

  // watch.mjs's contract is that adapters re-read + diff on every fire, so a fire with
  // no real change must stay silent. Emit ONLY on an actual transition — never a no-op.
  function onChange() {
    const s = status();
    if (!s) {
      // Degraded read (CLI unset, or the query failed). Report once on entry, then stay quiet.
      if (!errored) {
        errored = true;
        emit(makeEvent('p-graph', 'index.refresh', '-', 'db changed', { error: cfg.pgraphCli ? true : undefined }));
      }
      return;
    }
    errored = false;

    // index.refresh: only on the first real observation or a genuine node-count change.
    if (last === null || s.nodes !== last.nodes) {
      const d = last === null ? 0 : s.nodes - last.nodes;
      const summary = last === null
        ? `${s.nodes} nodes indexed`
        : `${d >= 0 ? `+${d}` : `${d}`} nodes (${s.nodes} total)`;
      emit(makeEvent('p-graph', 'index.refresh', '-', summary, s));
    }

    // drift.warn: only when the drift count actually changes to a positive value.
    // Tracking last.drift means a real clear (→0) followed by new drift re-warns correctly.
    if (s.drift > 0 && s.drift !== last?.drift) {
      emit(makeEvent('p-graph', 'drift.warn', '-', `drift ${s.drift} files`, s));
    }

    last = s; // always advance the baseline, even when nothing was emitted
  }

  return {
    _onChange: onChange, // test seam
    backfill() { const s = status(); if (s) last = s; },
    start() { if (existsSync(dirname(paths.graphDb))) watcher = watchPath(dirname(paths.graphDb), onChange); },
    stop() { if (watcher) watcher.close(); watcher = null; },
    status() { return last ?? {}; },
  };
}
