import { isPidAlive, listRunningJobs } from './pids.mjs';
import { resolveGroup } from './concurrency.mjs';

// Who is holding this scope right now, answered from p-shed's OWN per-job pidfiles.
// Never from pgrep: measured on the live system, `ssh host "pgrep -f 'claude -p …'"`
// matches the ssh command itself and reports the loop busy forever.
//
// Global scope counts every live pidfile, including one whose job has since been removed
// from jobs.yml — that process is still writing the checkout, which is the whole
// question being asked. Group scope uses resolveGroup, so `defaults` inheritance and an
// explicit `null` opt-out behave exactly as the tick's group gate does.
export function listHolders({ root, jobs = [], defaults = {}, group = null, isAlive = isPidAlive } = {}) {
  const live = listRunningJobs(root, { isAlive });
  if (!group) return live;
  const members = new Set(jobs.filter((j) => resolveGroup(j, defaults) === group).map((j) => j.id));
  return live.filter((e) => members.has(e.id));
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Block until the scope is free, or the timeout expires. Changes NO state — this is the
// honest primitive, and it is what a human wants when the next step is manual. The
// liveness check comes before the deadline check so a zero timeout still answers
// truthfully for an already-idle loop.
export async function waitForIdle({
  root, jobs = [], defaults = {}, group = null,
  timeoutMs = 1_800_000, pollMs = 1000,
  isAlive = isPidAlive, now = () => Date.now(), sleep = realSleep,
  isAborted = () => false,
} = {}) {
  const started = now();
  for (;;) {
    const holders = listHolders({ root, jobs, defaults, group, isAlive });
    if (holders.length === 0) return { idle: true, aborted: false, waitedMs: now() - started, holders: [] };
    // Cancellation is checked alongside the deadline, not only around the command: a
    // Ctrl+C thirty seconds into a thirty-minute wait must unwind now, so the caller can
    // release whatever it holds instead of sitting here until the timeout.
    if (isAborted()) return { idle: false, aborted: true, waitedMs: now() - started, holders };
    if (now() - started >= timeoutMs) return { idle: false, aborted: false, waitedMs: now() - started, holders };
    await sleep(pollMs);
  }
}
