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
  `skipped-group` (+ `group`, `holder`) and writes **nothing to its own state** — no
  `lastRun`, no breaker movement — so catch-up starts it on the first tick after the
  group frees. The hold IS visible in the run log, though: see the group-holds bullet
  further down for the batched `group-held` row this now writes and the card it feeds.
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
  server the operator runs, wired up in `jobs.yml` like any other job. A separate
  dashboard plugin that read `.pshed/` from outside was considered and rejected: it
  would need its own parser for `jobs.yml`, kept in step by hand with this plugin's
  real one (js-yaml-based, `lib/io.mjs`) — duplicated knowledge that drifts. `report`
  renders from inside p-shed instead, off the same data and the same parser.
- **The page carries no JavaScript and fetches nothing.** Charts are server-rendered
  SVG; expanders are native `<details>`. It is read on a phone, and a half-loaded
  dashboard is worse than a plain one. `__tests__/html.test.ts` pins the absence of
  `<script`, `http://` and `https://`.
- **Every job is one post in a single feed, whatever its state.** `lib/html.mjs`'s
  `jobPost` renders the same skeleton for a broken job and a healthy one — before this,
  a broken job got its own card and every healthy job was a row in a shared table, two
  shapes on one page. Only the trouble line and the output-tail `<details>` are
  conditional on the job's state; everything else (next/last, schedule/model/group,
  runs and cost in the window, guard freshness) always tries to print. `renderHtml`
  takes two more arguments for this: the EFFECTIVE jobs array `pshed.mjs` already builds
  for `computeNext` (schedule/model/concurrencyGroup — `collectStatus` returns runtime
  state only, none of that), and `defaults` from `jobs.yml`, because a job's group AND
  its model are resolved through the same job-then-defaults precedence the scheduler
  itself uses — `resolveGroup` (`lib/concurrency.mjs`) for the group, `effectiveModel`
  (`lib/html.mjs`, mirroring `launch.mjs`'s `buildArgs`) for the model — not read off
  `job.concurrencyGroup` / `job.model` directly. A job with no group or model of its own
  can still inherit either from `defaults` — the ordinary way to configure a loop, and
  before `effectiveModel` existed this silently showed no model at all on every post in
  such a loop. `effectiveTimeoutSec` (same file) resolves the same way, one step
  further, all the way to p-shed's built-in 900s, for the "slowest runs" card's timeout
  column. A job in `status.jobs` with no matching entry in the jobs array (state
  left behind by a job removed from `jobs.yml`) still renders, just without the
  schedule/model/group line. The feed is one column at every width (`.feed`, no
  `auto-fit`/`minmax`, `max-width:640px`, centred) — a laptop showing three or four
  columns was the layout this branch replaced.
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
  win over both. **A job whose own run is still alive gets `at: null`, never a guessed
  time — checked before all of the above.** `nextRun` only answers "the next matching
  cron minute from now"; it has no idea a run is still going and will still be going
  when that minute arrives. Printing the guess named a launch the tick's own baseline/
  pid-alive gates would simply not make, and since the report re-renders on a schedule,
  the guessed time slid forward every render — a job stuck forever read as "coming up
  soon" forever. This took three fix rounds to get right and is the rule most likely to
  get "simplified" away next.
- **Day buckets come from `ts` in local time, never from the log file name.** Log files
  are named by UTC date while schedules fire in local time; on UTC+3 the two disagree by
  three hours, and bucketing by file name silently drops the local end of the window.
- **A broken profile shows in the report's "Scheduler health" card, not as a job
  problem.** `profileNote` (`lib/html.mjs`) prints `profile.problem` / `profile.warning`
  even when no profile name resolved at all — the case an operator most needs to catch,
  since the scheduler is then quietly ticking at its default pace instead of the
  configured one. It is not one of the three states that count toward the page's
  problem tally (breaker, self-pause, quota retry): a broken profile can affect every
  job at once, so folding it into a per-job count would double-count or misreport it.
- **The header shows only task name, problem count, window cost and the generated-at
  stamp — everything else moved into a "Scheduler health" card.** Cron install state,
  the global pause (with its origin and reason) and the active profile used to live in
  the header's small print; saying the same thing in two places on one page added
  nothing. What stays in the header is deliberately the minimum that defends against a
  dead render job serving stale numbers: the reader needs the generated-at stamp next
  to the numbers it describes, not two scrolls away.
- **A job whose failures are climbing but whose breaker has not tripped gets its own
  feed bucket, between the real problems and the summary cards — and it is NOT one of
  the three problem states.** `isAccumulating` (`lib/html.mjs`) is
  `!breakerTripped && consecutiveFailures > 0 && effectiveMaxFailures > 0` — the same
  precedence tick.mjs uses for `maxConsecutiveFailures` (job, then `defaults`, then 3).
  Folding it into the problem count was tried and rejected: a count that includes jobs
  which never actually stopped is a count nobody trusts, and the page's problem tally
  is pinned at exactly three states on purpose (see above). But the same job must not
  sit at the bottom of a now-long feed where nobody scrolls, so it gets a bucket of its
  own, right after the real problems. `maxConsecutiveFailures <= 0` disables the
  breaker for that job entirely, so an ever-climbing count there is not a warning and
  prints nothing.
- **Six summary cards: cost by model, quota, group holds, slowest runs, tokens, and
  scheduler health.** The group-holds card used to be left out on purpose, because the
  `skipped-group` gate in `tick.mjs` wrote no log row at all and the report had nothing
  real to read. `tick.mjs` now logs it: a `group-held` row (`action`, no `outcome` —
  same distinct shape as `reclaimed-deploy-pause`, `job: null`) carrying a `held` array
  of every `{ id, group, holder }` the tick skipped that minute.
  - **One row per TICK, not one per held job.** The gate itself still writes nothing —
    no `lastRun`, no breaker movement, so catch-up still starts the job on the first
    free tick; only the log gained a line. The noise risk is real: a minutely job stuck
    behind a thirty-minute groupmate would write a row every minute for the whole half
    hour if logged per job, and a tick where several jobs share one held group would
    multiply that further. Batching into one row per tick removes both multipliers at
    once — the worst case becomes one row per tick for as long as a hold lasts, capped
    by how long real runs actually take (unlike a quiet guard, a hold cannot exist
    without a groupmate genuinely running), never the 1440-rows/day a per-job, per-tick
    row would risk on a busy loop.
  - `aggregate()` (`lib/report.mjs`) folds every `group-held` row's `held` array into
    `groupHolds: { total, rows }`, keyed by the `(job, group, holder)` triple so the
    same pairing across many ticks becomes one row with a count rather than one row per
    tick — `total` counts every entry seen (even one that fails to key, the same
    "an unrecognised value still counts, just isn't bucketed" rule `outcomes` follows),
    `rows` only the well-formed triples, sorted busiest-first and capped like
    `slowestRuns`. `groupHoldsCard` (`lib/html.mjs`) renders it next to `quotaCard` —
    both answer "why did this job not run, when nothing is broken?" — and says
    `no group holds in Nd` rather than an empty box when nothing was held.
- **Cost by model folds `usage.models` (`classify.mjs`'s `parseModelUsage`) the same way
  cost-by-job folds `usage.costUsd`: `costUsd` starts `null` and only becomes a number
  once one is actually seen for that model.** A model with token counts but no parsed
  cost stays out of the ranking rather than showing as a misleading $0.00 row.
- **Quota and Slowest-runs read fields report.mjs's `aggregate()` already had to start
  tracking:** `byDay[].usageLimit` / `.apiOverload` (a per-day split of the existing
  `totals.skips`), `totals.lastResetAt` (the verbatim reset text a limit message most
  recently quoted, tracked by the record's own `ts` so input order never matters — the
  reporting form from `classify.mjs`'s `parseResetAt`, not a parsed timestamp), and
  `slowestRuns` (every record with a numeric `durationMs`, sorted longest first and
  capped at 8 total AND at 2 per job — the per-job cap is walked AFTER the sort, so a
  job's slowest run is the one that survives — so record order never matters there
  either). The per-job cap exists because one chronically slow job otherwise fills every
  row and the card stops showing where time goes across the whole scheduler; two is
  enough to show a job is consistently slow while leaving room for others. All three
  fields are additive to `aggregate()`'s return shape and follow its existing rule: a
  missing or non-numeric field is left out,
  never coerced.
- **`defaults.logRetentionDays` replaces the old hardcoded `retentionDays = 7` default
  parameter on `rotateLogs`, and it is read TWICE, on purpose, in two different moods.**
  Before this, nothing could ever pass a third argument to `rotateLogs` — not `jobs.yml`,
  not an env var, not a flag — so `report`, which reads straight from these files, could
  never show more history than seven days no matter what an operator wanted: the numbers
  were collected correctly and then thrown away. `jobFieldError`'s `logRetentionDays`
  case (`lib/jobs.mjs`) is the one rule; `resolveLogRetentionDays` (`lib/logs.mjs`) reads
  it LENIENTLY for the tick — missing, non-numeric, or negative all fall back to 7
  instead of throwing, because a typo'd retention setting must shrink the tick's history,
  not stop the loop. `report` reads the same field STRICTLY (exit 2 on a bad value)
  because a human runs it, often via the guard-only job this README documents, and a
  config mistake should be loud there instead of silently doing the wrong thing forever.
  This is the same lenient/strict split `lib/profile.mjs` already uses for
  `applyProfile` vs `validateProfiles` — one rule, two callers, never two copies of the
  rule itself. `0` means "keep every log forever", not "0-day retention": `rotateLogs`
  treats any `retentionDays <= 0` as a no-op, because the cutoff formula would otherwise
  land in the FUTURE for a negative value and delete every file, including the one
  today's tick is still appending to.
- **The report's window is the same number, not a second one.** `pshed.mjs`'s `report`
  command calls `resolveLogRetentionDays(jobsData.defaults)` — the exact helper and the
  exact field the tick already resolves for rotation, never read a second way — and
  passes the result to both `windowStart` (deciding which log files `readLogRecords`
  even opens) and `aggregate`'s `windowDays` option. Raising retention to 30 now also
  makes the report a 30-day report; there is no separate knob, because a page that
  shows 7 days while 30 sit on disk is the exact defect this wiring exists to close —
  the numbers were being collected and then thrown away before a trend could show.
  `windowDays: 0` cannot zero-fill an unbounded window, so `aggregate` (`lib/report.mjs`)
  special-cases it: it scans every record it was given for the oldest `ts`, and shows
  however many local days that takes to reach, ending today (a `logs/` with nothing in
  it yet still shows one bucket, today's — the same shape the fixed-size window already
  has when nothing was ever run). `windowStart(now, 0)` returns `-Infinity` for the same
  reason: the CLI needs a lower bound no real record's `ts` can be less than, so
  `readLogRecords` excludes nothing and every file still on disk gets read. The returned
  `windowDays` is always this computed span, never the literal `0` that was passed in —
  every heading on the page ("Cost · N days", "Runs · N days", the quota card, the
  footer) already read `agg.windowDays` rather than a hardcoded 7, so fixing it in one
  place fixes every heading at once.
