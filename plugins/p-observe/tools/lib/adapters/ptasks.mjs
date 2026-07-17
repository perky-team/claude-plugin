import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeEvent } from '../event.mjs';
import { watchPath, safeRead } from '../watch.mjs';

// Zero-dep tolerant extractor: pair each `id:` with the nearest following `status:`
// within the same list item. Never throws — returns a (possibly empty) Map.
// Torn-read detection is handled by the adapter's read gate, NOT here.
export function readTaskStates(text) {
  const map = new Map();
  let pendingId = null;
  for (const line of text.split('\n')) {
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

  function readNow() {
    const raw = safeRead(paths.tasksFile, (s) => s); // {ok:false} only if the file is missing/unreadable
    if (!raw.ok) return { ok: false };
    const text = raw.value;
    // Complete tasks.yml (js-yaml dump) is non-empty and ends with a newline.
    // Empty or mid-line-truncated read => torn write; skip this tick, keep baseline.
    // Residual limitation: a truncation landing exactly on a line boundary that drops
    // trailing whole tasks still passes this gate; rarer than a mid-line cut and self-heals
    // on the next real change.
    if (text.length === 0 || !text.endsWith('\n')) return { ok: false };
    return { ok: true, value: readTaskStates(text) };
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
