import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeEvent } from '../event.mjs';
import { watchPath, safeRead } from '../watch.mjs';

// Zero-dep tolerant extractor: pair each `id:` with the nearest following `status:`
// within the same list item. Good enough for diffing without a YAML parser.
export function readTaskStates(text) {
  const map = new Map();
  const lines = text.split('\n');
  let pendingId = null;

  // Detect obviously corrupted files (torn reads starting with JSON/invalid markers)
  if (text.length > 0 && (text.startsWith('{') || text.startsWith('['))) {
    throw new Error('Invalid task file format (looks like corrupted JSON)');
  }

  for (const line of lines) {
    const idM = /(?:^|\s)-?\s*id:\s*["']?([^"'\s]+)/.exec(line);
    if (idM) { pendingId = idM[1]; continue; }
    const stM = /(?:^|\s)status:\s*["']?([A-Za-z_]+)/.exec(line);
    if (stM && pendingId) { map.set(pendingId, stM[1]); pendingId = null; }
  }
  return map;
}

export function createPtasksAdapter({ paths, emit }) {
  let baseline = new Map();
  let watcher = null;

  const parse = (text) => readTaskStates(text);

  function readNow() {
    return safeRead(paths.tasksFile, parse); // {ok, value} | {ok:false}
  }

  function diffNow() {
    const r = readNow();
    if (!r.ok) return; // torn read — keep baseline, retry next tick
    const next = r.value;
    for (const [id, status] of next) {
      if (!baseline.has(id)) emit(makeEvent('p-tasks', 'task.added', id, `added (${status})`, { status }));
      else if (baseline.get(id) !== status) emit(makeEvent('p-tasks', 'task.status', id, `${baseline.get(id)} → ${status}`, { from: baseline.get(id), to: status }));
    }
    for (const id of baseline.keys()) if (!next.has(id)) emit(makeEvent('p-tasks', 'task.removed', id, 'removed', {}));
    baseline = next;
  }

  return {
    _diffNow: diffNow, // test seam
    backfill() { const r = readNow(); if (r.ok) baseline = r.value; },
    start() { if (existsSync(dirname(paths.tasksFile))) watcher = watchPath(dirname(paths.tasksFile), diffNow); },
    stop() { if (watcher) watcher.close(); watcher = null; },
    status() {
      const counts = {};
      for (const status of baseline.values()) counts[status] = (counts[status] ?? 0) + 1;
      return { counts };
    },
  };
}
