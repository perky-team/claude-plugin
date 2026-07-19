import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeEvent } from '../event.mjs';
import { watchPath, safeRead } from '../watch.mjs';
import { scalarValue, unquote } from './scalars.mjs';

// Tolerant per-item scanner over js-yaml.dump output. Never throws.
// Item boundary is the `- id:` dash line; fields are captured within the item.
export function readTasks(text) {
  const lines = text.split('\n');
  const map = new Map();
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const dash = /^\s*-\s+id:\s*(.*)$/.exec(lines[i]);
    if (dash) {
      cur = { status: '?', title: '', description: '' };
      map.set(unquote(dash[1].trim()), cur);
      continue;
    }
    if (!cur) continue;
    const kv = /^\s+(status|title|description):/.exec(lines[i]);
    if (kv) cur[kv[1]] = scalarValue(lines, i);
  }
  return map;
}

export function readTaskStates(text) {
  const out = new Map();
  for (const [id, t] of readTasks(text)) out.set(id, t.status);
  return out;
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
    return { ok: true, value: readTasks(text) }; // Map<id, {status,title,description}>
  }

  function diffNow() {
    const r = readNow();
    if (!r.ok) return; // torn read — keep baseline, retry next tick
    const next = r.value;
    for (const [id, t] of next) {
      if (!baseline.has(id)) emit(makeEvent('p-tasks', 'task.added', id, `added (${t.status})`, { status: t.status }));
      else if (baseline.get(id).status !== t.status) emit(makeEvent('p-tasks', 'task.status', id, `${baseline.get(id).status} → ${t.status}`, { from: baseline.get(id).status, to: t.status }));
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
      const tasks = {};
      for (const [id, t] of baseline) {
        counts[t.status] = (counts[t.status] ?? 0) + 1;
        tasks[id] = { status: t.status, title: t.title, description: t.description };
      }
      return { counts, tasks };
    },
  };
}
