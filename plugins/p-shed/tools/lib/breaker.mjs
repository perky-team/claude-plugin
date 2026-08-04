import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, readJobState, writeJobState } from './io.mjs';

// Task-level pause marker: `claude -p` exits 0 even when the job's own work
// failed, so a job signals "stop scheduling me" by writing this file from inside
// its run. It lives under run/ (not state/) so the orphan-prune never touches it
// and clearing it is a plain file delete.
export function pausePath(root, id) {
  return join(paths(root).runDir, `${id}.pause`);
}

// The marker now has three possible ORIGINS — the job pausing itself, an operator
// running `pshed pause --id/--group`, or a deploy holding the loop during maintenance.
// `reset-breaker` must clear the first and keep the other two (a deliberate human pause
// is lifted by the human via `resume`; a deploy pause is lifted by the deploy itself or
// the tick's orphan reclaim).
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
export const DEPLOY_ORIGIN_LINE = '#pshed origin=deploy';

// Three origins now. `deploy` exists so the tick's orphan reclaim can lift a pause a
// dead `pshed deploy` abandoned WITHOUT touching one a human set deliberately — if the
// two were indistinguishable, the reclaim would silence the whole loop on its own, the
// exact failure the deploy dance was written to prevent. The pid deliberately does NOT
// go in this header: `#pshed origin=deploy pid=123` fails the regex, reads back as a
// self-pause, and reset-breaker on an unrelated job then deletes a live deploy's pause.
// The owner lives in run/DEPLOY instead (lib/owner.mjs).
const KNOWN_ORIGINS = new Set(['self', 'operator', 'deploy']);

// { origin: 'self' | 'operator' | 'deploy', reason } for a present marker, else null. An
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
  if (!m) return { origin: 'self', reason: raw.replace(/\r?\n$/, '') };
  const body = nl === -1 ? '' : raw.slice(nl + 1);
  // An unrecognised header value still reads as `operator`: only p-shed writes headers,
  // and refusing to auto-clear a marker we don't fully understand is the safe direction.
  const origin = KNOWN_ORIGINS.has(m[1]) ? m[1] : 'operator';
  return { origin, reason: body.replace(/\r?\n$/, '') };
}

// The human-readable reason (never the header), or null when there is no marker. An
// empty marker returns '' — a string, so callers testing `!= null` still see a pause.
export function readPause(root, id) {
  const rec = readPauseRecord(root, id);
  return rec === null ? null : rec.reason;
}

// The literal header line for a given non-self origin — built from the constants above
// instead of re-templating `#pshed origin=${origin}` here, so ORIGIN_HEADER's regex and
// the two lines it must match never drift apart.
function originLine(origin) {
  return origin === 'deploy' ? DEPLOY_ORIGIN_LINE : OPERATOR_ORIGIN_LINE;
}

// Create the marker. Idempotent by design: pausing an already-paused job is a no-op
// that KEEPS the existing reason — the first reason is the one that explains why the
// job stopped, and an operator pause must not paper over a self-pause it walked into.
export function writePause(root, id, { reason, origin = 'operator' } = {}) {
  const existing = readPauseRecord(root, id);
  if (existing) {
    // An operator pause landing on a deploy-origin marker takes OWNERSHIP of it: origin
    // flips to the caller's own and the reason is replaced when one was given — so the
    // human's halt survives the deploy's own release, which only clears a marker still
    // carrying ITS origin (see dropOwnPauses in lib/deploy.mjs). A marker already
    // 'operator' or 'self' is unchanged: pausing an already-paused job keeps the FIRST
    // reason, which is what explains why the job actually stopped.
    if (existing.origin === 'deploy' && origin !== 'deploy') {
      const text = typeof reason === 'string' && reason.trim() !== '' ? reason : existing.reason;
      mkdirSync(paths(root).runDir, { recursive: true });
      writeFileSync(pausePath(root, id), `${originLine(origin)}\n${text}\n`, 'utf-8');
      return { id, paused: true, alreadyPaused: true, tookOwnership: true, origin, reason: text };
    }
    return { id, paused: true, alreadyPaused: true, origin: existing.origin, reason: existing.reason };
  }
  const text = typeof reason === 'string' && reason.trim() !== ''
    ? reason
    : (origin === 'self' ? '' : `paused by ${origin}`);
  mkdirSync(paths(root).runDir, { recursive: true });
  const body = origin === 'self' ? `${text}\n` : `${originLine(origin)}\n${text}\n`;
  writeFileSync(pausePath(root, id), body, 'utf-8');
  return { id, paused: true, alreadyPaused: false, origin, reason: text };
}

export function removePause(root, id) {
  rmSync(pausePath(root, id), { force: true });
}

// Un-stick a job: clear the process-level breaker in state and remove the task-level
// pause marker — but ONLY a self-pause. Clearing an operator or deploy pause here would
// mean an unrelated breaker reset silently lifts a halt a human put there on purpose or a
// deploy is holding, so those survive and are reported instead. Idempotent; safe when
// either is absent.
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
  // Only a SELF pause is cleared here. Both an operator pause and a deploy-held one are
  // someone else's to lift: the human via `resume`, the deploy via its own release (or
  // the tick's reclaim once its owner is gone).
  const keep = pause != null && pause.origin !== 'self';
  if (pause && !keep) removePause(root, id);
  const held = keep
    ? (pause.origin === 'deploy'
        ? { deployPause: true, pauseReason: pause.reason, hint: `a running deploy holds this pause; it lifts when the deploy finishes, or the next tick reclaims it if the deploy died` }
        : { operatorPause: true, pauseReason: pause.reason, hint: `operator pause kept; lift it with: pshed resume --id ${id}` })
    : {};
  return { id, cleared: true, pauseCleared: pause != null && !keep, ...held };
}

// Every job id with a pause marker on disk, stale ones included. Symmetric with
// listPidEntries() in pids.mjs and deliberately independent of jobs.yml: a job deleted
// from jobs.yml can still have left a marker behind, and the reclaim must find it.
export function listPauseIds(root) {
  const dir = paths(root).runDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^(.+)\.pause$/.exec(f))
    .filter(Boolean)
    .map((m) => m[1]);
}
