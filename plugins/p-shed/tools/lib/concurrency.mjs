// Cross-job concurrency groups: at most one LIVE run per group, so jobs sharing a
// working directory can be serialized by the scheduler instead of by an external
// `flock` around claudeBin. A lock is the wrong shape here — `timeoutSec` covers the
// whole spawn, so time spent queued is charged to the run's budget (measured: a 600 s
// chat job killed while waiting behind a 30-minute job). p-shed already has
// missed-tick catch-up, so the right answer is "not now, next tick": a held group is a
// SKIP, never a wait (see CLAUDE.md, "Duplicate guard, not a lock").
import { readPid as realReadPid, isPidAlive } from './pids.mjs';

// A job's group: its own field wins — including an explicit null/'' meaning
// "unconstrained, ignore the default" — then defaults.concurrencyGroup, then none.
// Anything that is not a non-empty string reads as no group, so a malformed value
// degrades to today's unconstrained behavior instead of wedging the tick.
export function resolveGroup(job, defaults = {}) {
  const own = job && Object.prototype.hasOwnProperty.call(job, 'concurrencyGroup');
  const raw = own ? job.concurrencyGroup : defaults?.concurrencyGroup;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

// The OTHER job currently holding `job`'s group, or null when the group is free (or
// the job has none). Liveness is derived from the per-job pidfiles that already
// exist: a `run/<group>.pid` would show up in listPidEntries() and invent a phantom
// job for both `status` and `stop`'s teardown, so this deliberately adds NO state.
// Scans in jobs.yml order — deterministic, no fairness scheme.
export function findGroupHolder({ root, job, jobs = [], defaults = {}, isAlive = isPidAlive, readPid = realReadPid }) {
  const group = resolveGroup(job, defaults);
  if (!group) return null;
  for (const other of jobs) {
    if (!other || other.id === job.id) continue;
    if (resolveGroup(other, defaults) !== group) continue;
    const pid = readPid(root, other.id);
    if (pid != null && isAlive(pid)) return { id: other.id, pid, group };
  }
  return null;
}
