import { readJobs, readConfig, readJobState, writeJobState, removeJobState, listStateIds } from './io.mjs';
import { parseCron, isDue } from './cron.mjs';
import { runJob as realRunJob } from './launch.mjs';
import { runGuard as realRunGuard } from './guard.mjs';
import { appendLog as realAppendLog, rotateLogs as realRotateLogs } from './logs.mjs';
import { readPause } from './breaker.mjs';
import { readGlobalPause } from './pause.mjs';
import { isPidAlive, readPid, writePid, removePid } from './pids.mjs';
import { findGroupHolder } from './concurrency.mjs';
import { classifyRun, classifySkipReason, parseUsage, resolveUsageLimitPattern, parseResetAt, truncateOutput } from './classify.mjs';

export async function tick({ root, now = Date.now(), deps = {} }) {
  const d = {
    readJobs, readConfig, readJobState, writeJobState, removeJobState, listStateIds,
    runJob: realRunJob, appendLog: realAppendLog, rotateLogs: realRotateLogs,
    runGuard: (job, defaults) => realRunGuard({ job, defaults, root }),
    isPidAlive, writePid: (id, pid) => writePid(root, id, pid), removePid: (id) => removePid(root, id),
    readGlobalPause,
    ...deps,
  };

  // Global pause: while run/PAUSED exists the whole scheduler is halted (cron stays
  // installed). This is the FIRST gate in the launch flow — before log rotation and any
  // job evaluation — so a paused tick is a genuine no-op, mirroring the per-job pause
  // marker but for every job at once.
  if (d.readGlobalPause(root)) return { action: 'tick', paused: true, launched: 0 };

  d.rotateLogs(root, now);
  const { defaults, jobs } = d.readJobs(root);
  const config = d.readConfig(root);
  const results = [];

  for (const job of jobs) {
    if (job.enabled === false) continue;
    const st = d.readJobState(root, job.id); // fresh per-job read

    if (!st || st.lastRun == null) {
      d.writeJobState(root, job.id, { lastRun: now, lastExit: null, pid: null });
      results.push({ id: job.id, action: 'baselined' });
      continue;
    }

    // Task-level self-pause: the job's own run dropped a marker asking not to be
    // scheduled (claude -p exits 0 even when the job's internal work went red).
    const pause = readPause(root, job.id);
    if (pause != null) { results.push({ id: job.id, action: 'skipped-paused', reason: pause }); continue; }

    // Process-level breaker: too many crash/timeout runs in a row already tripped it.
    if (st.breakerTripped) { results.push({ id: job.id, action: 'skipped-breaker', reason: st.breakerReason }); continue; }

    const pid = readPid(root, job.id) ?? st.pid;
    if (d.isPidAlive(pid)) { results.push({ id: job.id, action: 'skipped' }); continue; }

    if (!isDue(parseCron(job.schedule), st.lastRun, now)) {
      results.push({ id: job.id, action: 'not-due' });
      continue;
    }

    // Cross-job duplicate guard: a groupmate is live, so this job does not start —
    // SKIPPED, not queued, exactly like the same-job guard above. Nothing is written:
    // no lastRun (the slot is not consumed), no breaker movement, so catch-up starts
    // this job on the first tick after the group frees. Placed after the schedule
    // check (only DUE jobs contend) and before the guard (no point running a guard
    // command for a launch that cannot happen).
    const holder = findGroupHolder({ root, job, jobs, defaults, isAlive: d.isPidAlive });
    if (holder) {
      results.push({ id: job.id, action: 'skipped-group', group: holder.group, holder: holder.id });
      continue;
    }

    // Guard: an owner-supplied cheap command in front of the Claude launch decides,
    // per due slot, whether the launch happens (exit 0), the slot is deliberately
    // quiet (75 — EX_TEMPFAIL, see lib/guard.mjs), or the guard itself is broken
    // (anything else / timeout). Runs AFTER every gate above, so a paused / tripped /
    // pid-alive / not-due job never executes its guard, and the baseline tick skips
    // it too. A quiet guard CONSUMES the slot (lastRun = now), mirroring the
    // usage-limit skip path: a daily job whose guard said quiet retries tomorrow,
    // not every minute all day.
    let guarded;
    if (job.guard) {
      const g = await d.runGuard(job, defaults);
      const lastGuard = { at: now, outcome: g.outcome, exit: g.exit };
      const prevG = d.readJobState(root, job.id) ?? {};
      if (g.outcome === 'quiet') {
        // Log-noise policy: quiet is state-only (lastGuard) — no history line. A
        // minutely chat job must not write 1440 quiet records/day; freshness is
        // visible via status.lastGuard instead.
        d.writeJobState(root, job.id, { ...prevG, lastRun: now, lastGuard, consecutiveGuardFailures: 0 });
        results.push({ id: job.id, action: 'guard-quiet' });
        continue;
      }
      if (g.outcome === 'error') {
        // Guard errors get their own counter — reset by a healthy guard (quiet or
        // pass), NOT by a healthy run — but share the breaker and its threshold, so
        // watchdogs keyed on breakerTripped need no change. A single shared counter
        // fails both ways: guard blips weeks apart would eventually trip a healthy
        // job, while a crashing run interleaved with quiet slots would never trip.
        const consecutiveGuardFailures = (prevG.consecutiveGuardFailures ?? 0) + 1;
        const maxFailures = job.maxConsecutiveFailures ?? defaults.maxConsecutiveFailures ?? 3;
        const next = { ...prevG, lastRun: now, lastGuard, consecutiveGuardFailures };
        if (maxFailures > 0 && consecutiveGuardFailures >= maxFailures) {
          next.breakerTripped = true;
          next.breakerReason = g.timedOut ? 'guard timeout' : (g.error ? `guard: ${g.error}` : `guard exit ${g.exit}`);
          next.breakerAt = now;
        }
        d.writeJobState(root, job.id, next);
        const rawG = truncateOutput(g.out, g.err);
        d.appendLog(root, { ts: now, job: job.id, outcome: 'guard-error', exit: g.exit, timedOut: g.timedOut, durationMs: g.durationMs, ...(rawG ? { raw: rawG } : {}) }, now);
        results.push({ id: job.id, action: 'guard-error', exit: g.exit, timedOut: g.timedOut });
        continue;
      }
      // pass: the guard is proven healthy — reset its counter, record freshness,
      // fall through to the launch. The post-run read-modify-write re-reads this.
      d.writeJobState(root, job.id, { ...prevG, lastGuard, consecutiveGuardFailures: 0 });
      guarded = true;
    }

    const r = await d.runJob({ job, defaults, claudeBin: config.claudeBin, onSpawn: (p) => { if (p) d.writePid(job.id, p); } });

    // Read-modify-write: preserve breaker/other fields instead of clobbering the whole
    // state object, then fold in this run's outcome.
    const prev = d.readJobState(root, job.id) ?? {};
    const outcome = classifyRun(r.exit, r.out, r.err, resolveUsageLimitPattern(defaults));

    // Self-reveal logging: for every non-success run, log the truncated raw output
    // alongside its classification. The exact headless usage-limit message shape is
    // unconfirmed, so a limit we failed to pattern-match stays visible in the log and
    // the pattern can be corrected (jobs.yml / env) after at most one breaker trip.
    const rawTail = outcome === 'success' ? undefined : truncateOutput(r.out, r.err);

    // Cost accounting: keep the compact usage block from EVERY run whose result JSON
    // parsed — success included, since those are the expensive ones. Purely additive
    // to the row (existing readers key off field names) and best-effort: a missing,
    // partial or malformed result just omits the block, never breaks the tick.
    const usage = parseUsage(r.out);
    const withRunDetail = (rec) => ({ ...rec, ...(rawTail ? { raw: rawTail } : {}), ...(usage ? { usage } : {}) });

    if (outcome === 'usage_limit') {
      // Quota/infra, not a code failure: do NOT touch the failure counter or breaker.
      // Record the skip so `status` can show a stuck-on-limit job; the next tick retries.
      // The reason distinguishes a real subscription limit from a transient API
      // overload — same scheduling, very different operational meaning.
      const reason = classifySkipReason(r.out, r.err);
      const resetAt = parseResetAt(r.out, r.err);
      const next = { ...prev, lastRun: now, lastExit: r.exit, pid: null, lastSkipReason: reason, lastSkipAt: now };
      if (resetAt) next.lastSkipResetAt = resetAt; else delete next.lastSkipResetAt;
      d.writeJobState(root, job.id, next);
      d.appendLog(root, withRunDetail({ ts: now, job: job.id, exit: r.exit, timedOut: r.timedOut, durationMs: r.durationMs, outcome: 'skipped', reason, ...(guarded ? { guarded: true } : {}), ...(resetAt ? { resetAt } : {}) }), now);
      d.removePid(job.id);
      results.push({ id: job.id, action: 'skipped-usage-limit', reason, ...(resetAt ? { resetAt } : {}) });
      continue;
    }

    // success | failure — unchanged breaker semantics (unhealthy = timed out OR exit !== 0),
    // plus clearing any stale usage-limit skip marker now that the job ran for real.
    const consecutiveFailures = outcome === 'success' ? 0 : (prev.consecutiveFailures ?? 0) + 1;
    const maxFailures = job.maxConsecutiveFailures ?? defaults.maxConsecutiveFailures ?? 3;
    const next = { ...prev, lastRun: now, lastExit: r.exit, pid: null, consecutiveFailures };
    delete next.lastSkipReason;
    delete next.lastSkipAt;
    delete next.lastSkipResetAt;
    if (maxFailures > 0 && consecutiveFailures >= maxFailures) {
      next.breakerTripped = true;
      next.breakerReason = r.timedOut ? 'timeout' : (r.error ?? `exit ${r.exit}`);
      next.breakerAt = now;
    } else {
      delete next.breakerTripped;
      delete next.breakerReason;
      delete next.breakerAt;
    }
    d.writeJobState(root, job.id, next);
    d.appendLog(root, withRunDetail({ ts: now, job: job.id, exit: r.exit, timedOut: r.timedOut, durationMs: r.durationMs, outcome, ...(guarded ? { guarded: true } : {}) }), now);
    d.removePid(job.id);
    results.push({ id: job.id, action: 'launched', exit: r.exit, timedOut: r.timedOut });
  }

  // Orphan prune: drop state files for jobs no longer in jobs.yml.
  for (const id of d.listStateIds(root)) {
    if (!jobs.some((j) => j.id === id)) d.removeJobState(root, id);
  }
  return results;
}
