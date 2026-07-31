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
      // Last quota/infra skip — `usage-limit` (subscription/credits) or `api-overload`
      // (429/529/5xx), neither a failure — so a stuck job is visible without paging
      // through logs. Undefined when the last run was real.
      lastSkipReason: st.lastSkipReason,
      lastSkipResetAt: st.lastSkipResetAt,
      // Guard freshness ("checked 40 s ago") + its failure counter. Undefined / 0
      // for guardless jobs.
      lastGuard: st.lastGuard,
      consecutiveGuardFailures: st.consecutiveGuardFailures ?? 0,
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

// Plain-text table for `status --human`. `now` is injectable so the guard-age
// column is testable.
export function formatHuman(status, now = Date.now()) {
  const lines = [];
  lines.push(`task:      ${status.task}`);
  lines.push(`installed: ${status.installed === null ? 'unknown' : status.installed}`);
  lines.push(`paused:    ${status.paused}${status.pauseReason ? ` (${status.pauseReason})` : ''}`);
  lines.push('');
  lines.push(['id', 'enabled', 'running', 'paused', 'breaker', 'fails', 'lastExit', 'lastSkip', 'guard'].join('\t'));
  for (const j of status.jobs) {
    const skip = j.lastSkipReason
      ? (j.lastSkipResetAt ? `${j.lastSkipReason} (resets ${j.lastSkipResetAt})` : j.lastSkipReason)
      : '-';
    const guard = j.lastGuard
      ? `${j.lastGuard.outcome} ${Math.max(0, Math.round((now - j.lastGuard.at) / 1000))}s ago`
      : '-';
    // Show WHY a job is paused, like the global `paused:` line above — a bare `true`
    // makes a job that stopped itself look identical to one an operator halted. Newlines
    // are collapsed so a multi-line marker can't break the row into fake table rows.
    const paused = j.paused
      ? (j.pauseReason ? `true (${String(j.pauseReason).replace(/\s+/g, ' ').trim()})` : 'true')
      : 'false';
    lines.push([
      j.id,
      j.enabled,
      j.running,
      paused,
      j.breakerTripped ? (j.breakerReason ?? 'tripped') : '-',
      j.consecutiveFailures,
      j.lastExit ?? '-',
      skip,
      guard,
    ].join('\t'));
  }
  return lines.join('\n');
}
