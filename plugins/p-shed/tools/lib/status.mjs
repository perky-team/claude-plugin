import { readJobs, readJobState } from './io.mjs';
import { readPause } from './breaker.mjs';
import { readGlobalPause } from './pause.mjs';
import { readPid, isPidAlive } from './pids.mjs';
import { taskName } from './scheduler.mjs';

// Aggregate the scheduler's live state from disk (jobs.yml + state/ + run/), plus an
// `installed` verdict the caller probes from the OS scheduler. Readers are injectable so
// the aggregation is testable without real processes or crontab.
export function collectStatus(root, { installed = null, deps = {} } = {}) {
  const d = { readJobs, readJobState, readPause, readGlobalPause, readPid, isPidAlive, ...deps };
  const { jobs } = d.readJobs(root);
  const gp = d.readGlobalPause(root);

  const jobStatuses = jobs.map((job) => {
    const st = d.readJobState(root, job.id) ?? {};
    const pauseReason = d.readPause(root, job.id);
    const pid = d.readPid(root, job.id) ?? st.pid ?? null;
    const running = d.isPidAlive(pid);
    return {
      id: job.id,
      enabled: job.enabled !== false,
      running,
      pid: running ? pid : null,
      paused: pauseReason != null,
      pauseReason: pauseReason != null ? pauseReason : undefined,
      breakerTripped: st.breakerTripped === true,
      breakerReason: st.breakerReason,
      consecutiveFailures: st.consecutiveFailures ?? 0,
      lastRun: st.lastRun ?? null,
      lastExit: st.lastExit ?? null,
      // Last usage-limit skip (quota/infra, not a failure), so a stuck-on-limit job
      // is visible without paging through logs. Undefined when the last run was real.
      lastSkipReason: st.lastSkipReason,
      lastSkipResetAt: st.lastSkipResetAt,
    };
  });

  return {
    action: 'status',
    task: taskName(root),
    installed,
    paused: gp != null,
    pauseReason: gp != null ? gp.reason : undefined,
    jobs: jobStatuses,
  };
}

// Plain-text table for `status --human`.
export function formatHuman(status) {
  const lines = [];
  lines.push(`task:      ${status.task}`);
  lines.push(`installed: ${status.installed === null ? 'unknown' : status.installed}`);
  lines.push(`paused:    ${status.paused}${status.pauseReason ? ` (${status.pauseReason})` : ''}`);
  lines.push('');
  lines.push(['id', 'enabled', 'running', 'paused', 'breaker', 'fails', 'lastExit', 'lastSkip'].join('\t'));
  for (const j of status.jobs) {
    const skip = j.lastSkipReason
      ? (j.lastSkipResetAt ? `${j.lastSkipReason} (resets ${j.lastSkipResetAt})` : j.lastSkipReason)
      : '-';
    lines.push([
      j.id,
      j.enabled,
      j.running,
      j.paused,
      j.breakerTripped ? (j.breakerReason ?? 'tripped') : '-',
      j.consecutiveFailures,
      j.lastExit ?? '-',
      skip,
    ].join('\t'));
  }
  return lines.join('\n');
}
