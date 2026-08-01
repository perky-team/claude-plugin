import { readJobs, readJobState } from './io.mjs';
import { readPauseRecord } from './breaker.mjs';
import { readGlobalPause } from './pause.mjs';
import { readPid, isPidAlive } from './pids.mjs';
import { taskName } from './scheduler.mjs';

// Aggregate the scheduler's live state from disk (jobs.yml + state/ + run/), plus an
// `installed` verdict the caller probes from the OS scheduler. Readers are injectable so
// the aggregation is testable without real processes or crontab.
export function collectStatus(root, { installed = null, deps = {} } = {}) {
  const d = { readJobs, readJobState, readPauseRecord, readGlobalPause, readPid, isPidAlive, ...deps };
  const { jobs } = d.readJobs(root);
  const gp = d.readGlobalPause(root);

  const jobStatuses = jobs.map((job) => {
    const st = d.readJobState(root, job.id) ?? {};
    // origin ('self' | 'operator' | 'deploy') so a deploy-held pause never LOOKS like an
    // operator forgot to `resume` — this is the exact confusion the origin field was
    // introduced to remove; resetBreaker already surfaces it (`deployPause: true`), and
    // status is the surface the README points an operator at first.
    const pauseRec = d.readPauseRecord(root, job.id);
    const pauseReason = pauseRec != null ? pauseRec.reason : null;
    const pid = d.readPid(root, job.id) ?? st.pid ?? null;
    const running = d.isPidAlive(pid);
    return {
      id: job.id,
      enabled: job.enabled !== false,
      running,
      pid: running ? pid : null,
      paused: pauseReason != null,
      pauseReason: pauseReason != null ? pauseReason : undefined,
      pauseOrigin: pauseRec != null ? pauseRec.origin : undefined,
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
    // Same origin visibility as per-job, above, for the global marker: a live `deploy`
    // and a halt an operator set and forgot about used to be indistinguishable here.
    // `writeGlobalPause` only ever writes an explicit `origin` for a `deploy` pause — a
    // plain `pause --reason ...` writes no origin field at all (see lib/pause.mjs) — so
    // a present marker with no `origin` key can only be an ordinary operator pause, never
    // "unknown". Defaulting to 'operator' here (instead of leaving it undefined) is what
    // makes a JSON consumer able to tell the two apart at all; per-job already can't be
    // ambiguous this way, since a written header always says which non-self origin it is.
    pauseOrigin: gp != null ? (gp.origin ?? 'operator') : undefined,
    jobs: jobStatuses,
  };
}

// Plain-text table for `status --human`. `now` is injectable so the guard-age
// column is testable.
export function formatHuman(status, now = Date.now()) {
  const lines = [];
  lines.push(`task:      ${status.task}`);
  lines.push(`installed: ${status.installed === null ? 'unknown' : status.installed}`);
  // origin distinguishes "a deploy is holding this open" from "an operator paused it and
  // forgot" — the whole reason the pause marker records an origin at all (see
  // lib/breaker.mjs / lib/pause.mjs). A plain operator pause has no origin field, so it
  // adds nothing here; only a non-default origin (deploy) is worth calling out.
  const originSuffix = status.pauseOrigin && status.pauseOrigin !== 'operator' ? ` [${status.pauseOrigin}]` : '';
  lines.push(`paused:    ${status.paused}${status.pauseReason ? ` (${status.pauseReason})` : ''}${originSuffix}`);
  lines.push('');
  lines.push(['id', 'enabled', 'running', 'paused', 'origin', 'breaker', 'fails', 'lastExit', 'lastSkip', 'guard'].join('\t'));
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
      j.paused ? (j.pauseOrigin ?? '-') : '-',
      j.breakerTripped ? (j.breakerReason ?? 'tripped') : '-',
      j.consecutiveFailures,
      j.lastExit ?? '-',
      skip,
      guard,
    ].join('\t'));
  }
  return lines.join('\n');
}
