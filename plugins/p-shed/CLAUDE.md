# p-shed — contributor guide

Pure scheduler/launcher. Key decisions:

- **Built-in cron matcher** (`tools/lib/cron.mjs`), not `cron-parser`: plugins ship as
  a plain file copy with no `npm install`, so deps must be vendored; `cron-parser`
  pulls transitive deps (luxon). Minute-granularity matching + catch-up is small and
  self-contained.
- **Duplicate guard, not a lock:** a per-job pidfile (`.pshed/run/<id>.pid`) skips a
  launch while the previous run is alive. No cross-job lock.
- **Concurrency groups extend that guard across jobs — still a skip, never a wait.**
  An optional `concurrencyGroup` (per job, or in `defaults`) means "at most one LIVE run
  per group": a due job whose group is held by a live groupmate reports
  `skipped-group` (+ `group`, `holder`) and writes **nothing** — no `lastRun`, no
  breaker movement — so catch-up starts it on the first tick after the group frees.
  `resolveGroup`/`findGroupHolder` live in `lib/concurrency.mjs`; an explicit
  `concurrencyGroup: null` on a job beats `defaults`, and no group anywhere is
  unconstrained (the pre-existing behavior). This exists so a deployment does not wrap
  `claudeBin` in an external `flock`: `timeoutSec` covers the whole spawn, so queued
  time is charged to the run's own budget — measured, a 600 s chat job was killed while
  waiting behind a 30-minute job. A scheduler with missed-tick catch-up must answer
  "not now, next tick", so do **not** turn this into a lock, a queue, or any form of
  waiting.
  - **Do not add a `run/<group>.pid`.** `listPidEntries()` maps every `run/*.pid`
    basename to a job id, and `status` + `stop`'s `terminateJobs` treat each entry as a
    job — a group pidfile would invent a phantom job for both. Group liveness is
    derived from the per-job pidfiles that already exist: zero new state, nothing to
    orphan-prune.
  - **Within one tick the loop stays sequential** (`for` + `await`), so two groupmates
    due in the same minute run back-to-back — never simultaneously, which is what the
    invariant actually requires. The gate is what stops a job from starting while a
    groupmate from an *earlier, still-running* tick holds the group. Evaluation is in
    `jobs.yml` order; no fairness scheme.
  - **`run <id>` claims the same pidfile.** It writes `run/<id>.pid` at spawn and
    clears it at exit, and refuses (`skipped` / `skipped-group`) when the job or its
    group is live; `--force` bypasses the refusal and then deliberately does NOT
    touch the incumbent's pidfile. Without this, a manual run is invisible to the tick
    and double-launches in the same working directory — the hole the external `flock`
    used to mask.
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
- **`pause`/`resume` targeting: an unmatched target MUST fail loudly.** `--id <job>` and
  `--group <name>` write/remove the same `run/<id>.pause` marker; no flags keeps the
  global `run/PAUSED`. `resolveTarget` (`lib/target.mjs`) throws on an unknown id, a
  group no job belongs to, both flags at once, or a valueless flag (`parseArgs` yields
  boolean `true` for `--id` with nothing after it). Do **not** "simplify" any of those
  back into a fallback: before this existed, `pause --id worker` silently ignored the
  flag and halted the ENTIRE scheduler, chat jobs included, while answering
  `{"action":"pause","paused":true}`. Widening a blast radius on a typo is the opposite
  of `rm-job`, which errors on a missing `--id`. Group membership comes from
  `resolveGroup`, never re-derived from `defaults`, so targeting and the tick's group
  gate can never disagree about who is in a group.
- **The pause marker records its ORIGIN, and `reset-breaker` clears only self-pauses.**
  A marker with no header is a self-pause (that is what a prompt's `echo reason >`
  and a bare `touch` produce); `pause --id/--group` prepends `#pshed origin=operator`.
  `reset-breaker` removes the first and keeps the second, reporting
  `pauseCleared`/`operatorPause` — otherwise resetting an unrelated breaker trip would
  silently lift a halt a human set deliberately, and the only lever to set one is the
  same file. Two invariants constrain the format and must not be traded away:
  **presence pauses** (never make it truthiness-of-contents, or `touch` stops working)
  and **the reason stays plain text** (`status`'s `pauseReason` / `--human` column and
  the tick's `skipped-paused` are where a human reads it — a JSON blob there is a
  regression). Pausing an already-paused job keeps the FIRST reason: it explains why
  the job actually stopped.
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
- **The skip REASON is split, and the structured signal is an allowlist.** Two separate
  rules hang off the classification above; both were bugs found in a live deployment.
  1. `classifySkipReason(out, err)` → `usage-limit` | `api-overload` labels the recorded
     skip (log `reason`, state `lastSkipReason`, `status`'s `lastSkip` column). Subscription
     wins when both signatures are present — it is the more consequential state and the one
     carrying a reset time. Keep it a **separate exported helper**, not a wider `classifyRun`
     return, so the 3-way contract and its callers/tests stay untouched. Scheduling is
     identical for both labels (skip, breaker untouched, retry next tick) — this is
     reporting only. Do not re-merge the labels: two logged "usage-limit" skips that were
     really `api_error_status: 529` made the bot look quota-starved when it was not.
  2. `structuredLimit` treats ONLY retryable statuses as a limit
     (`RETRYABLE_API_STATUSES` = 408/429/500/502/503/504/529). Any other non-null
     `api_error_status` — 400 bad request, 401 expired credential, 403 revoked key — falls
     through to `failure` **on purpose**: it will fail identically forever, so it belongs to
     the breaker. Do not widen this back to "any non-null status", which turned a dead
     credential into an infinite silent skip that looked healthy to every watchdog keyed on
     `breakerTripped`. The text path's numeric codes stay scoped to an `api error …` context.
- **Every run's cost is logged, success included.** `parseUsage(out)` (`classify.mjs`,
  reusing `parseResult` — do not duplicate the salvage parse) folds the
  `--output-format json` result into a compact `usage` block on the log row
  (`costUsd`, `in`/`out`/`cacheRead`/`cacheCreate`, `turns`, `apiMs`, per-model `models`).
  Successful runs are the expensive ones and their result was previously parsed for
  classification and thrown away, leaving wall-clock duration — meaningless across models
  and effort levels — as the only cost proxy. It is strictly **additive** (existing
  consumers read by field name) and **never throws**: missing/partial/non-numeric fields
  are omitted, a result with no usable numbers omits the whole block. The scheduler's job
  is to schedule; one weird run must not wedge the loop.
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
