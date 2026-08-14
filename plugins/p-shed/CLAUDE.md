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
  the job actually stopped — **except an operator pause landing on a still-live
  `deploy`-origin marker, which takes OWNERSHIP of it instead** (origin flips to
  `operator`, and the reason is replaced when one is given). Without that exception, a
  human's incident halt placed mid-deploy would be silently lifted the instant the
  deploy finished and released — `release()` only ever clears a marker still carrying
  ITS OWN origin (see `dropOwnPauses` in `lib/deploy.mjs`), so flipping the origin is
  what makes the halt survive. Every other combination — self/self, operator/operator,
  self walked into by an operator — keeps the first reason unchanged; this is the one
  carve-out, and it exists only because `deploy` release is the one actor that would
  otherwise auto-clear a marker a human is actively relying on.
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
- **A quota/overload skip does NOT consume the slot — and staying due must be bounded.**
  The skip path exists to say "this was not the job's fault", and proves it by refusing to
  touch `consecutiveFailures` or the breaker. Writing `lastRun = now` contradicted the same
  judgement: measured, a `20 6 * * *` job classified `api-overload` at 09:05 was not due
  again until 06:20 the NEXT morning. The old comment there promised "the next tick
  retries" — true for a minutely job, false for a sparse one, and speed profiles made
  sparse schedules ordinary. So `lastRun` is left alone. Two things make that safe and
  they are not optional:
  1. **`retryNotBefore` is the bound.** Without it a minutely job relaunches `claude -p`
     every 60 s for a whole five-hour window. It is the parsed reset time when the message
     carried one, else `min(60s · 2^(n-1), 30 min)` from `consecutiveSkips`
     (`lib/backoff.mjs`). The gate sits AFTER the schedule check (so a job that is not due
     reports `not-due`, not a misleading wait) and BEFORE the group gate and the guard (no
     owner-supplied command runs for a launch that cannot happen), and it writes and logs
     **nothing** — same log-noise policy as the quiet-guard path.
  2. **Every path that advances `lastRun` clears the retry** (`clearRetry`): a real run,
     a quiet guard, a guard error. Paths that write no state — paused, breaker, pid-alive,
     group-held — deliberately leave it, since the retry outlives those.
  A pending retry also keeps the job due past `isDue`'s 24-hour catch-up clamp
  (`isDue(...) || st.retryNotBefore != null`). Without that, a weekly job loses a week to
  the identical defect; with it the override can still only ever add ONE launch, because
  the first real run clears it. Do **not** collapse this into a `nextDueOverride`: that is
  a second scheduling authority beside cron + `lastRun`, and the two drift.
  - **`parseResetTime` (`classify.mjs`) is a SEPARATE function from `parseResetAt`,** and
    must stay one. `parseResetAt` is the reporting form — free text shown verbatim in
    `status`/logs — and its capture stops at `.` so a sentence's full stop never lands in
    the string. That truncation silently breaks an ISO timestamp: it drops the
    milliseconds *and* the trailing `Z`, so `…T19:15:00.000Z` reads back as LOCAL time —
    a three-hour error on a UTC+3 box. `parseResetTime` therefore rescans a dot-tolerant
    60-char window and clamps every branch to `(now, now + 48h]`, which is also what
    rejects V8 reading a bare `3` as the year 2003. Being wrong is cheap by construction
    (an early retry just re-skips), and that is the ONLY reason parsing a human message is
    allowed to feed a scheduling decision at all.
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
- **Never `process.exit()` in the CLI — set `process.exitCode` and return.** A write to a
  PIPE is asynchronous in Node while a write to a FILE is synchronous, so exiting on the
  next line tears the process down with bytes still queued. Measured on the live board:
  a `--json` listing delivered 853 212 bytes to a file and 65 536 — exactly one pipe
  buffer — through a pipe. The truncated text fails `JSON.parse`, a careful consumer
  catches that and reports "no data", so a **corrupt read is indistinguishable from an
  empty one**: a watchdog polling `pshed status | …` reads a scheduler whose every job
  has tripped its breaker as a scheduler with no jobs. `emitJson`/`die` therefore only
  set the code, and every call site must `return` them. The same rule reached p-chat
  first, from a different failure (a hard exit while undici held a keep-alive socket
  aborted the process on Windows) — see `plugins/p-chat/CLAUDE.md`.
  - **This bug is INVISIBLE on Windows**, where pipe writes are synchronous. The
    behavioural proof (`__tests__/stdout-pipe.test.ts`) is green on win32 no matter how
    broken the code is, and only goes red under WSL — the exact trap `.claude/CLAUDE.md`
    exists for. `tests/cli-exit-safety.test.ts` pins the mechanism statically so at
    least *that* half holds on every platform.
  - `deploy` and `wait-idle` set `process.exitCode` too, and their reports stay on
    **stderr** — unchanged, and load-bearing: stdout belongs to the deployed command.
- Deps vendored via `scripts/vendor-deps.mjs` (js-yaml only), same pattern as p-tasks.
- **`wait-idle` waits; the TICK still never does.** The "not now, next tick" rule above
  governs the scheduler: a held concurrency group is a skip, never a queue or a lock, and
  that must not change. `wait-idle` and `deploy` are foreground OPERATOR commands — a
  human (or a deploy script) is blocked on them, no job's `timeoutSec` budget is being
  charged, and nothing is queued. Do not "unify" the two by teaching the tick to wait, and
  do not delete the wait as a violation of the tick's rule: they answer different questions.
- **The deploy dance is ordered, and the order is load-bearing.** wait-idle → pause →
  re-check → run → release. Pausing FIRST silences every job, chat included, for the whole
  remaining run of an in-flight worker (measured: 20 minutes of silence); waiting first
  costs seconds. The re-check exists because a job can launch in the gap; when it does,
  `deploy` undoes only its own pause and waits again.
- **Ownership is a file, not a signal trap.** `run/DEPLOY` names the process holding a
  deploy pause, and `tick` reclaims a deploy-origin marker whose owner is dead — BEFORE
  its global-pause gate, since that gate short-circuits on any marker regardless of
  origin. This is not belt-and-braces: measured, a Node process on Windows receives
  neither SIGTERM nor SIGINT, so a trap cannot be the mechanism there at all. Do not put
  the owner pid in the pause header — `#pshed origin=deploy pid=123` fails `ORIGIN_HEADER`,
  reads back as a SELF pause, and `reset-breaker` on an unrelated job then deletes a live
  deploy's pause. Do not name the file `*.pid` either: `listPidEntries` would invent a
  phantom job for `status` and `stop --kill`.
- **`deploy` has no `--id`, and rejects it loudly.** Pausing one job while a groupmate
  keeps writing the same checkout is a window that only looks safe. `parseArgs` swallows
  unknown flags, so ignoring `--id` would silently mean "pause everything" — the same
  blast-radius widening `lib/target.mjs` exists to prevent.
- **`report` renders; it never serves.** p-shed has no HTTP server, no port, and no
  access decision, and must not grow one — delivery is an off-the-shelf static file
  server the operator runs, wired up in `jobs.yml` like any other job. A dashboard
  plugin that read `.pshed/` from outside was considered and rejected: that is exactly
  what p-observe does — `plugins/p-observe/tools/lib/adapters/pshed.mjs` keeps its own
  hand-rolled parser for `jobs.yml`, separate from and in step with this plugin's own
  (js-yaml-based) one in `lib/io.mjs`.
- **The page carries no JavaScript and fetches nothing.** Charts are server-rendered
  SVG; expanders are native `<details>`. It is read on a phone, and a half-loaded
  dashboard is worse than a plain one. `__tests__/html.test.ts` pins the absence of
  `<script`, `http://` and `https://`.
- **Run outcomes are four stat tiles, never one stacked proportion bar.** The four
  status colours fail the palette checks as adjacent fills — critical against good
  measures dE 4.1 under deuteranopia, serious against warning 13.6 for normal vision,
  under a floor of 15. Status colours are built to be read one at a time, next to an
  icon and a label. Do not "tidy" the tiles back into a bar.
- **`computeNext` checks `isDue` before falling back to `nextRun` — except a job that
  has never run, which skips `isDue` and goes straight to `nextRun`.** p-shed catches
  missed ticks up, so a job whose slot passed is due NOW; `nextRun` alone would print a
  time hours away for a job that launches in sixty seconds. `isDue` must never be asked
  about a job with no `lastRun`: it reads a missing `lastRun` as "24 hours ago", which
  counts as due for anything more frequent than daily. It also reads the EFFECTIVE
  schedule (profiles rewrite `schedule` in memory) and lets a pending `retryNotBefore`
  win over both.
- **Day buckets come from `ts` in local time, never from the log file name.** Log files
  are named by UTC date while schedules fire in local time; on UTC+3 the two disagree by
  three hours, and bucketing by file name silently drops the local end of the window.
- **A broken profile shows in the report's header line, not as a job problem.**
  `profileNote` (`lib/html.mjs`) prints `profile.problem` / `profile.warning` next to the
  cron/pause line even when no profile name resolved at all — the case an operator most
  needs to catch, since the scheduler is then quietly ticking at its default pace
  instead of the configured one. It is not one of the three states that count toward the
  page's problem tally (breaker, self-pause, quota retry): a broken profile can affect
  every job at once, so folding it into a per-job count would double-count or misreport
  it.
