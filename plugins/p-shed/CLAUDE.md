# p-shed — contributor guide

Pure scheduler/launcher. Key decisions:

- **Built-in cron matcher** (`tools/lib/cron.mjs`), not `cron-parser`: plugins ship as
  a plain file copy with no `npm install`, so deps must be vendored; `cron-parser`
  pulls transitive deps (luxon). Minute-granularity matching + catch-up is small and
  self-contained.
- **Duplicate guard, not a lock:** a per-job pidfile (`.pshed/run/<id>.pid`) skips a
  launch while the previous run is alive. No cross-job lock.
- **Timeout is the recovery mechanism:** because runs are unattended and the duplicate
  guard skips live runs, a hung run would wedge the job forever; the timeout kills the
  process tree so the next tick recovers.
- **No task storage, no rule:** p-shed never reads/writes work items and `init` writes
  no `.claude/rules` file. It does not depend on or modify any other plugin.
- **Two failure classes, two guards.** The process-level circuit breaker keys off the
  launch exit (timeout/non-zero → unhealthy) and lives in `state/<id>.json`
  (`consecutiveFailures`, `breakerTripped`). The task-level self-pause is a `run/<id>.pause`
  marker the job's own prompt writes, because `claude -p` exits 0 even when its internal
  work failed. The pause is a **file under `run/`, not a state field** — so the state
  orphan-prune never clobbers it and clearing it is a plain delete.
- **Three-way run classification, not two.** `tick` no longer branches on `exit === 0`
  alone; it calls `classifyRun(exit, out, err)` (`lib/classify.mjs`) → `success` |
  `usage_limit` | `failure`. A Claude usage-limit or transient API overload (`429`/`529`,
  `overloaded_error`, `rate_limit_error`, the subscription-limit messages) is quota/infra,
  not a code failure, so it must **skip** — breaker counter untouched, no trip, next tick
  retries. Because Claude Code has no distinct exit code or JSON subtype for a limit,
  detection is by **message text** — hence `launch.mjs` now pipes+captures stdout/stderr
  (`stdio: ['ignore','pipe','pipe']`, tail-capped at 64 KB) instead of `'ignore'`, and the
  captured `out`/`err` ride along in the run result. The pattern is a single const in
  `classify.mjs`, overridable via `defaults.usageLimitPattern` (jobs.yml) or
  `PSHED_USAGE_LIMIT_PATTERN` (env); an invalid override degrades to the built-in rather
  than throwing and wedging the tick. Every failed run logs its truncated raw output +
  classification (self-reveal), so an unmatched limit shape is visible after one trip. Do
  **not** collapse this back to a 2-way check — a false "failure" here re-introduces the
  bug where a quota window trips the breaker and needs a manual `reset-breaker`.
- **State writes are read-modify-write.** `tick` merges into the existing state object
  (spread prev, then set lastRun/lastExit/pid/consecutiveFailures/breaker) rather than
  replacing it, so breaker fields survive across ticks.
- **Guards: one breaker, two counters, exit 75.** A job's optional `guard` command
  (lib/guard.mjs) runs after all other gates and before the launch; 0 = launch,
  75 = quiet skip (EX_TEMPFAIL — deliberate, so a crash can never read as quiet;
  do NOT "simplify" to 0/nonzero), else = guard error. Guard errors have their own
  `consecutiveGuardFailures` (reset by any healthy guard result, not by a healthy
  run) but trip the same breaker. Quiet skips consume the schedule slot and write
  NO history-log line — state (`lastGuard`) + `status` only. `run <id>` respects
  the guard (`--no-guard` bypasses) and stays stateless.
- Deps vendored via `scripts/vendor-deps.mjs` (js-yaml only), same pattern as p-tasks.
