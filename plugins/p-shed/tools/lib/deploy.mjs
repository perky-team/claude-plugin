import { isPidAlive } from './pids.mjs';
import { listHolders, waitForIdle } from './idle.mjs';
import { writeDeployOwner, removeDeployOwner } from './owner.mjs';
import { writeGlobalPause, removeGlobalPause, readGlobalPause } from './pause.mjs';
import { writePause, readPauseRecord, removePause } from './breaker.mjs';
import { resolveGroup } from './concurrency.mjs';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noop = () => {};

// The deploy dance. The ORDER is the feature:
//   own -> wait -> pause -> re-check -> run -> release
// Pausing before waiting for idle silences every job — including the read-only chat
// ones — for the entire remaining run of an in-flight worker; measured on the live
// system as 20 minutes of silence. Waiting first costs about four seconds.
//
// The re-check exists because a job can launch in the gap between "idle" and "paused".
// When that happens we undo our own pause and go back to waiting, inside whatever is
// left of the timeout, rather than deploying into a live run.
export async function runDeploy({
  root, jobs = [], defaults = {}, group = null, reason,
  timeoutMs = 1_800_000, pollMs = 1000,
  cmd, args = [], pid = process.pid, deps = {},
} = {}) {
  const d = {
    waitForIdle, listHolders, isAlive: isPidAlive,
    now: () => Date.now(), sleep: realSleep, onStep: noop, isAborted: () => false,
    spawn: null, // required; the CLI injects the real one
    ...deps,
  };
  const scope = group ? 'group' : 'global';
  const started = d.now();
  const remaining = () => Math.max(0, timeoutMs - (d.now() - started));
  const members = () => jobs.filter((j) => resolveGroup(j, defaults) === group).map((j) => j.id);

  // Ownership is claimed BEFORE any pause, so the "marker exists, owner unknown" window
  // cannot open. If this process dies from here on, the next tick reclaims whatever it
  // placed — the only recovery path on Windows, where no signal reaches a handler.
  writeDeployOwner(root, { pid, scope, group, reason, now: d.now() });

  let pausedIds = [];
  let ownedGlobal = false;
  let preserved = [];
  let attempts = 0;

  const release = () => {
    if (ownedGlobal) removeGlobalPause(root);
    for (const id of pausedIds) removePause(root, id);
    pausedIds = [];
    ownedGlobal = false;
    removeDeployOwner(root);
  };

  try {
    for (;;) {
      attempts++;
      const waited = await d.waitForIdle({
        root, jobs, defaults, group, timeoutMs: remaining(), pollMs,
        isAlive: d.isAlive, now: d.now, sleep: d.sleep, isAborted: d.isAborted,
      });
      d.onStep('wait');
      if (!waited.idle) {
        // Nothing was paused and nothing ran — the honest failure, whether the wait ran
        // out or the operator interrupted it. Ownership is dropped by the finally below.
        return {
          outcome: waited.aborted ? 'aborted' : 'timeout', exit: waited.aborted ? 130 : 1,
          waitedMs: d.now() - started, attempts,
          scope, group, pausedIds: [], ownedGlobal: false, preserved: [], holders: waited.holders,
        };
      }

      d.onStep('pause');
      preserved = [];
      if (scope === 'global') {
        const before = readGlobalPause(root);
        if (before) preserved.push({ scope: 'global' });
        else { writeGlobalPause(root, { reason, origin: 'deploy', now: d.now() }); ownedGlobal = true; }
      } else {
        for (const id of members()) {
          const existing = readPauseRecord(root, id);
          if (existing) { preserved.push({ scope: 'job', id, origin: existing.origin }); continue; }
          writePause(root, id, { reason, origin: 'deploy' });
          pausedIds.push(id);
        }
      }

      const stragglers = d.listHolders({ root, jobs, defaults, group, isAlive: d.isAlive });
      d.onStep('recheck');
      if (stragglers.length === 0) break;

      // A job started in the gap. Undo only what we placed, then wait again.
      d.onStep('undo');
      if (ownedGlobal) removeGlobalPause(root);
      for (const id of pausedIds) removePause(root, id);
      pausedIds = [];
      ownedGlobal = false;
      if (remaining() === 0) {
        return {
          outcome: 'timeout', exit: 1, waitedMs: d.now() - started, attempts,
          scope, group, pausedIds: [], ownedGlobal: false, preserved: [], holders: stragglers,
        };
      }
    }

    const result = await d.spawn({ cmd, args });
    d.onStep('run');
    return {
      outcome: 'ok', exit: result.exit, signal: result.signal ?? null,
      waitedMs: d.now() - started, attempts, scope, group,
      pausedIds: [...pausedIds], ownedGlobal, preserved,
    };
  } finally {
    // Unconditional: success, non-zero exit, a throw, or (on POSIX) a signal that got
    // this far. A deploy that dies holding a global pause takes the whole loop down.
    d.onStep('release');
    release();
  }
}
