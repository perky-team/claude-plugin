import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, readJobState, writeJobState } from './io.mjs';

// Task-level pause marker: `claude -p` exits 0 even when the job's own work
// failed, so a job signals "stop scheduling me" by writing this file from inside
// its run. It lives under run/ (not state/) so the orphan-prune never touches it
// and clearing it is a plain file delete.
export function pausePath(root, id) {
  return join(paths(root).runDir, `${id}.pause`);
}

// The marker now has two possible ORIGINS — the job pausing itself, or an operator
// running `pshed pause --id/--group` — because `reset-breaker` must clear the first
// and keep the second (a deliberate human pause is lifted by the human, via `resume`).
//
// The format stays a plain-text reason, with the origin on an OPTIONAL first line.
// Two properties this preserves, both load-bearing:
//   1. presence pauses, not truthiness of contents — a bare `touch` leaves an empty
//      file and must keep pausing the job;
//   2. a marker written by a prompt that knows nothing about origins (`echo "verify
//      went red" > run/x.pause`) reads as a self-pause whose reason is that line, so
//      the reason `status` and the tick report never turns into a machine blob.
const ORIGIN_HEADER = /^#pshed origin=([a-z]+)$/;
export const OPERATOR_ORIGIN_LINE = '#pshed origin=operator';

// { origin: 'self' | 'operator', reason } for a present marker, else null. An
// unrecognised header value reads as `operator`: only p-shed ever writes a header, and
// refusing to auto-clear a marker we don't fully understand is the safe direction.
export function readPauseRecord(root, id) {
  const p = pausePath(root, id);
  if (!existsSync(p)) return null;
  let raw;
  try { raw = readFileSync(p, 'utf-8'); }
  catch { return null; }
  const nl = raw.indexOf('\n');
  const first = (nl === -1 ? raw : raw.slice(0, nl)).replace(/\r$/, '');
  const m = ORIGIN_HEADER.exec(first);
  if (!m) return { origin: 'self', reason: raw };
  const body = nl === -1 ? '' : raw.slice(nl + 1);
  return { origin: m[1] === 'self' ? 'self' : 'operator', reason: body.replace(/\r?\n$/, '') };
}

// The human-readable reason (never the header), or null when there is no marker. An
// empty marker returns '' — a string, so callers testing `!= null` still see a pause.
export function readPause(root, id) {
  const rec = readPauseRecord(root, id);
  return rec === null ? null : rec.reason;
}

// Create the marker. Idempotent by design: pausing an already-paused job is a no-op
// that KEEPS the existing reason — the first reason is the one that explains why the
// job stopped, and an operator pause must not paper over a self-pause it walked into.
export function writePause(root, id, { reason, origin = 'operator' } = {}) {
  const existing = readPauseRecord(root, id);
  if (existing) return { id, paused: true, alreadyPaused: true, origin: existing.origin, reason: existing.reason };
  const text = typeof reason === 'string' && reason.trim() !== ''
    ? reason
    : (origin === 'operator' ? 'paused by operator' : '');
  mkdirSync(paths(root).runDir, { recursive: true });
  const body = origin === 'operator' ? `${OPERATOR_ORIGIN_LINE}\n${text}\n` : `${text}\n`;
  writeFileSync(pausePath(root, id), body, 'utf-8');
  return { id, paused: true, alreadyPaused: false, origin, reason: text };
}

export function removePause(root, id) {
  rmSync(pausePath(root, id), { force: true });
}

// Un-stick a job: clear the process-level breaker in state and remove the task-level
// pause marker — but ONLY a self-pause. Clearing an operator pause here would mean an
// unrelated breaker reset silently lifts a halt a human put there on purpose, so that
// one survives and is reported instead. Idempotent; safe when either is absent.
export function resetBreaker(root, id) {
  const st = readJobState(root, id);
  if (st) {
    delete st.breakerTripped;
    delete st.breakerReason;
    delete st.breakerAt;
    st.consecutiveFailures = 0;
    delete st.consecutiveGuardFailures;
    writeJobState(root, id, st);
  }
  const pause = readPauseRecord(root, id);
  const operatorPause = pause?.origin === 'operator';
  if (pause && !operatorPause) removePause(root, id);
  return {
    id,
    cleared: true,
    pauseCleared: pause != null && !operatorPause,
    ...(operatorPause
      ? { operatorPause: true, pauseReason: pause.reason, hint: `operator pause kept; lift it with: pshed resume --id ${id}` }
      : {}),
  };
}
