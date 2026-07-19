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
- **State writes are read-modify-write.** `tick` merges into the existing state object
  (spread prev, then set lastRun/lastExit/pid/consecutiveFailures/breaker) rather than
  replacing it, so breaker fields survive across ticks.
- Deps vendored via `scripts/vendor-deps.mjs` (js-yaml only), same pattern as p-tasks.
