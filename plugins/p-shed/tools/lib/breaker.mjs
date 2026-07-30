import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { paths, readJobState, writeJobState } from './io.mjs';

// Task-level self-pause marker: `claude -p` exits 0 even when the job's own work
// failed, so a job signals "stop scheduling me" by writing this file from inside
// its run. It lives under run/ (not state/) so the orphan-prune never touches it
// and clearing it is a plain file delete.
export function pausePath(root, id) {
  return join(paths(root).runDir, `${id}.pause`);
}

export function readPause(root, id) {
  const p = pausePath(root, id);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, 'utf-8'); }
  catch { return null; }
}

export function removePause(root, id) {
  rmSync(pausePath(root, id), { force: true });
}

// Un-stick a job: clear the process-level breaker in state and remove any
// task-level pause marker. Idempotent; safe when either is absent.
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
  removePause(root, id);
  return { id, cleared: true };
}
