# p-shed

Scheduler/launcher for Claude Code headless runs. `p-shed` schedules **jobs** (cron
timer + folder + prompt) and, on each due minute, launches `claude -p` in the job's
folder. It is a pure scheduler: it does not store or resolve work items and installs
no rules — what to do lives entirely in each job's prompt and in the target folder.

## Skills

| Skill | Purpose |
|---|---|
| `/p-shed:init` | Scaffold `.pshed/` in the current folder. |
| `/p-shed:start` | Install the every-minute OS scheduler entry (`pshed tick`). |
| `/p-shed:stop` | Remove the OS scheduler entry. |
| `/p-shed:job` | Add, modify, or delete a scheduled job. |
| `/p-shed:reset-breaker` | Un-stick a job whose circuit breaker tripped or that self-paused. |

## Commands

Tool: `node tools/pshed.mjs <command>` (exit `0` ok / `1` env / `2` validation; most commands also support `--json`†):

| Command | Purpose |
|---|---|
| `tick` | Cron entry point — run every due job once. Invoked by the OS scheduler each minute. |
| `run <id>` `[--no-guard]` `[--force]` | Run one job immediately, bypassing the schedule (manual/testing). Respects the job's guard (`--no-guard` bypasses) and refuses while the job or its concurrency group is already live (`--force` bypasses). |
| `set-job` | Add or modify a job (`--schedule`, `--prompt`, `--id`, `--cwd`, `--timeoutSec`, `--permission-mode`, `--allowed-tools`, `--model`, `--effort`, `--max-consecutive-failures`, `--guard`, `--guard-timeout-sec`, `--concurrency-group`). |
| `rm-job` | Delete a job (`--id`). |
| `reset-breaker <id>` | Clear a job's tripped circuit breaker and its **self**-pause marker so it schedules again. An operator pause (`pause --id`) survives — lift that with `resume --id`. |
| `pause` / `resume` | Reversibly halt / resume the **whole** scheduler (`run/PAUSED`; cron stays installed), or with `--id <job>` / `--group <name>` just that job or every member of that concurrency group (`run/<id>.pause`). `pause` accepts `--reason`; both idempotent. An unknown id, an unmatched group, or both flags at once is an error (exit 2) — never a global pause. |
| `wait-idle` | Block until no job (or no member of `--group`) holds a live pidfile. Changes no state. `--timeout-sec` (default 1800), `--poll-ms` (default 1000). Human-readable report by default; `--json` for machine output (mirrors `deploy`, below). Exit `0` idle / `1` timed out (holder named) / `2` validation. |
| `deploy` | Open a maintenance window and run a command in it: wait for idle → pause → re-check → run → always release. `--reason` required, `--group` optional, then `-- <cmd> [args...]`. Refuses outright (does not wait, does not pause) when another `deploy` already holds `run/DEPLOY` with a live pid, naming that pid and its reason. The command's stdout/stderr pass through untouched and its exit code becomes `deploy`'s; p-shed's own report — including every validation error — goes to stderr, honouring `--json`, so nothing but the deployed command's own output ever reaches stdout. Exit: the command's own code when it ran (`0` on success) / `1` the wait timed out or deploy itself failed / `2` validation (`--id` given, `--reason` or command missing) or another deploy already in progress / `127` the command could not be spawned — POSIX only, on Windows the shell reports plain `1` / `128+signum` killed by a signal / `130` operator interrupted. Nothing is left paused in any of these cases — the one exception is deliberate: if an operator's own `pause`/`pause --group` lands on this deploy's marker while the command is still running, it takes ownership (see `run/PAUSED` below), and release leaves that alone. The report (`takenOver`, JSON and human) says so instead of claiming `released`; the exit code is still the command's own, since it genuinely ran and succeeded. |
| `profile show` / `set <name>` / `list` | The speed profile — one word that changes the whole loop's pace (see below). `show` reports the active name, **which source it came from**, and the per-job resolution; `set` writes the name to the file named by `config.profileFile` and refuses when there is none configured or the name is not in `profiles:`; `list` names the defined profiles. `show` takes `--human`. |
| `status` | Report, from disk + the OS scheduler: installed?, globally paused?, the active profile (when there is one), and per job running/paused/breaker/last-run — all at their **effective** values, i.e. with the profile applied. JSON by default, `--human` for a text table. |
| `report` `[--out <path>]` | Render a self-contained HTML page — cost over the last 7 days, what is broken, what runs next — to stdout, or atomically to a file. Read-only: it writes nothing under `.pshed/` and needs no network. |
| `stop` `[--kill]` | Honest teardown of the OS scheduler entry — reports `removed: true|false` (see below). `--kill` also SIGTERM→SIGKILLs any in-flight jobs (`--grace-ms` tunes the escalation delay). |
| `install-cron` / `remove-cron` | Register/unregister the every-minute `tick` in the OS scheduler for this folder. `remove-cron` reports `removed` and warns on a cwd mismatch (see below). |

† Most commands exit as stated in the header; `deploy` is an exception — see its row for the full code set. `report` ignores `--json` and always prints HTML. Its exit codes still match the header: `0` written, `1` no `.pshed/` or the write failed, `2` `--out` given with no value.

## Formats

`.pshed/` layout:

| File | Tracked? | Contents |
|---|---|---|
| `jobs.yml` | git | `version`, `defaults` (may carry `profile:`), `jobs[]{ id, schedule, enabled, cwd?, prompt, timeoutSec?, permissionMode?, allowedTools?, model?, effort?, maxConsecutiveFailures?, guard?, guardTimeoutSec?, concurrencyGroup? }`, optional `profiles{}` (see Speed profiles) |
| `config.json` | gitignore | `{ nodeBin, claudeBin, profileFile? }` (resolved at init; `profileFile` is the path — absolute, or relative to the repo root — of the file holding the active profile name) |
| `state/<id>.json` | gitignore | per-job `{ lastRun, lastExit, pid, consecutiveFailures, consecutiveGuardFailures?, lastGuard?, breakerTripped?, breakerReason?, breakerAt?, lastSkipReason?, lastSkipAt?, lastSkipResetAt?, consecutiveSkips?, retryNotBefore? }` — one file per job (no shared state file). `lastSkip*` records the most recent skip (`lastSkipReason` is `usage-limit` or `api-overload`) and is cleared once the job runs for real again; `retryNotBefore` (epoch ms) is the earliest moment a quota/overload skip may relaunch and `consecutiveSkips` counts the run of them — both absent unless a retry is pending, and both cleared by any path that consumes the slot; `lastGuard` records the most recent guard check (`{ at, outcome, exit, reason? }` — `reason` is the last non-empty line of the guard's stdout, collapsed to one line and capped at 120 chars; absent when the guard printed nothing) |
| `logs/<date>.jsonl` | gitignore | one record per run (see below); auto-rotated on `defaults.logRetentionDays` (default 7 days, `0` keeps every log forever). `report` (below) can only ever show what these files still hold, so a short retention also shortens the report |
| `run/<id>.pid` | gitignore | duplicate-guard pidfile |
| `run/<id>.pause` | gitignore | per-job pause marker (contents = a human-readable reason). A job's own run writes it to stop being scheduled; `pause --id/--group` writes the same file with a leading `#pshed origin=operator` line. Presence pauses, so a bare `touch` works and an empty marker is a valid self-pause |
| `run/PAUSED` | gitignore | global pause marker (`{ createdAt, reason?, origin? }`); halts every job while cron stays installed. Written by `pause`, removed by `resume`. An operator `pause` landing on a `deploy`-origin marker takes ownership of it (origin flips to its own, reason replaces the deploy's) so the halt survives the deploy's own release |
| `run/DEPLOY` | gitignore | `{pid, scope, group, reason, createdAt}` — the process holding a deploy pause, written atomically (temp file + rename) so a concurrent reader never sees a torn write. Written before the pause; the tick reclaims any deploy-origin pause whose owner is gone. One slot, not a lock: a second `deploy` refuses to start while this names a LIVE pid, and a deploy only ever removes this file when it still names its OWN pid. |

### Run log records (`logs/<date>.jsonl`)

One JSON object per line, appended per run and rotated after 7 days. Fields are added,
never renamed or removed — read by name and ignore what you don't know. There are two
kinds of row, distinguished by which fields they carry — a consumer should branch on
`action` being present before assuming the run-record shape below:

**Run records** — one per job launch/skip/guard-error. `ts` is always present:

| Field | When | Meaning |
|---|---|---|
| `ts`, `job`, `durationMs` | always | when, which job, wall-clock of the launch |
| `exit`, `timedOut` | always | process exit (`null` when killed by the timeout) |
| `outcome` | always | `success` \| `failure` \| `skipped` \| `guard-error` |
| `reason` | `skipped` | `usage-limit` (subscription/credits) or `api-overload` (429/529/5xx) |
| `resetAt` | when parsed | reset time lifted out of a limit message, verbatim |
| `retryAt` | `skipped` | epoch ms the job may relaunch — the reset time when one parsed, otherwise the backoff |
| `guarded` | guarded jobs | the launch passed a guard |
| `raw` | non-success | truncated tail of the run's output (self-reveal, 2 KB) |
| `usage` | result JSON parsed | what the run cost — see below |

**Reclaim records** — one per tick that lifted an abandoned deploy pause (see
`run/DEPLOY` above, in the `.pshed/` layout table). Not a run: no job launched, so it carries neither `outcome` (never
one of the four run values above) nor a real `durationMs`, and `job` is explicit `null`
rather than an absent field:

    {"ts":1784154000000,"job":null,"action":"reclaimed-deploy-pause",
     "reclaimed":[{"scope":"global"}]}

The `usage` block is captured for **every** run whose `--output-format json` result
parsed, successful runs included, so "which job is expensive" is answerable without
guessing from duration. Any field that is missing or non-numeric is simply omitted, and
a run with no usable numbers (non-JSON output, a timeout-killed run) logs no `usage`
block at all:

    {"ts":1784154000000,"job":"worker","exit":0,"timedOut":false,"durationMs":120431,
     "outcome":"success","usage":{"costUsd":0.42,"in":1234,"out":5678,"cacheRead":90123,
     "cacheCreate":4567,"turns":12,"apiMs":98765,
     "models":{"claude-opus-4-5-20260101":{"in":1234,"out":5678,"costUsd":0.42}}}}

Example `jobs.yml`:

    version: 1
    defaults:
      cwd: "."
      timeoutSec: 900
      permissionMode: acceptEdits
      allowedTools: "Read,Write,Edit,Bash(git *)"
      model: sonnet
      effort: low
      maxConsecutiveFailures: 3
      # usageLimitPattern: "my-custom-limit-regex"  # optional; overrides the built-in limit/overload detector
      # logRetentionDays: 7   # optional; default 7, 0 keeps every log forever, negative is invalid
    jobs:
      - id: task-runner
        schedule: "*/15 * * * *"
        enabled: true
        prompt: "Take the next unblocked work item in this repo and complete it."
      - id: strategist
        schedule: "0 9 * * *"
        enabled: true
        effort: high
        prompt: "Review the roadmap and propose the next quarter's priorities."

## Model selection

Set `model` on a job (or on `defaults`) to pass `--model <name>` to `claude` for that
run; a per-job `model` overrides `defaults.model`. Omit it to use the caller's default
model. Any name `claude --model` accepts works (e.g. `sonnet`, `opus`, `haiku`).

## Reasoning effort

Set `effort` on a job (or on `defaults`) to pass `--effort <level>` to `claude` for that
run; a per-job `effort` overrides `defaults.effort`. Valid levels are `low`, `medium`,
`high`, and `xhigh` — anything else is rejected with a validation error (exit `2`). Omit
it (on both the job and `defaults`) to let `claude` use its own default. The flag is
**silently skipped for Haiku models** — `--effort` errors on Haiku 4.5 — so a job whose
resolved `model` matches `haiku` never receives it even when `effort` is set.

## Concurrency groups (coordinating different jobs)

Jobs that share a working directory must not run at the same time. Set
`concurrencyGroup` — per job, or on `defaults` for every job that does not override it —
and p-shed allows **at most one live run per group**:

    version: 1
    defaults:
      concurrencyGroup: tree      # every job inherits this…
    jobs:
      - id: worker                # …so `worker` is in group `tree`
        schedule: "*/15 * * * *"
        prompt: "Take the next work item."
      - id: chat-responder
        schedule: "* * * * *"
        concurrencyGroup: chat    # its own group — runs even while `tree` is busy
        prompt: "Answer the pending question."
      - id: probe
        schedule: "0 * * * *"
        concurrencyGroup: null    # explicitly unconstrained, ignores the default
        prompt: "Report health."

- A due job whose group is held by a live groupmate is **skipped for this tick** —
  `{"action":"skipped-group","group":"tree","holder":"worker"}`. There is no queue, no
  lock file and no waiting.
- The skip writes **nothing**: no `lastRun`, no breaker movement. Missed-tick catch-up
  starts the job on the first tick after the group frees, so nothing is lost.
- Jobs with no group (neither their own nor a default) are unconstrained — the
  behavior every existing config already has.
- `skipped` (this job's own previous run is still alive) and `skipped-group` (a
  groupmate is) are different diagnoses and are reported separately.
- Within one tick, due jobs are evaluated in `jobs.yml` order and launched one after
  another, so two groupmates due in the same minute run back-to-back — never at the
  same time. The gate is what stops a job from starting while a groupmate launched by
  an earlier, still-running tick holds the group. Ordering is deterministic; there is
  no fairness scheme.
- `pshed run <id>` obeys the same rule: it refuses with `skipped`/`skipped-group` while
  the job or its group is live, and `--force` overrides for debugging.

**Why not `flock`?** Because `timeoutSec` covers the whole spawn, so time spent waiting
for a lock is charged to the run's own budget: a chat job with a 600 s timeout queued
behind a 30-minute job gets killed before it ever starts, and raising its timeout to
1800 s just turns a one-minute job into one that may answer half an hour late. A
scheduler with catch-up should say "not now, next tick" instead of waiting.

Set it from the CLI with `--concurrency-group <name>`; `--concurrency-group ""` writes
an explicit `null`, i.e. "this job is unconstrained even if `defaults` sets a group".
(Unlike `--guard ""`, it does not delete the field — deleting it would silently
re-inherit the default.)

## Speed profiles

One word changes how hard the whole loop works. Without it, slowing down means editing
`schedule` / `model` / `effort` / `timeoutSec` on several jobs — several independent
writes with no transaction, easy to leave half-applied. Measured cost of getting the pace
wrong once: the whole subscription quota burned by evening, then two days losing 70 and 16
runs to usage-limit skips.

**The table** lives in `jobs.yml` (rarely edited, and every edit is a reviewable diff):

```yaml
defaults:
  profile: eco          # lowest-precedence source of the active name
profiles:
  eco:
    worker:     { schedule: '0 */3 * * *' }
    strategist: { schedule: '20 6 * * *', model: sonnet }
    planner:    { enabled: false }
  fast:
    worker:     { schedule: '0,30 * * * *' }
```

Overridable per job: `schedule`, `model`, `effort`, `timeoutSec`, `enabled`. Nothing else —
a profile is a pace control, not a second place to define a job.

**The active value** is resolved in this order:

| # | source | `show` reports |
|---|---|---|
| 1 | `PSHED_PROFILE` environment variable | `env` |
| 2 | first line of the file named by `profileFile` in `config.json` | `file` + the path |
| 3 | `defaults.profile` in `jobs.yml` | `default` |
| 4 | — | `none` |

Point 2 is the reason this feature exists: **`jobs.yml` is inside the repository the loop
writes to, so a knob stored there is a knob the loop can turn.** `config.json` holds only
a *path*; the value it points at lives wherever the operator wants — outside the scheduled
checkout. `pshed profile set` writes exactly that file and **refuses when no `profileFile`
is configured** rather than silently falling back to somewhere inside the repo.

Semantics worth knowing:

- **Overrides are applied in memory, at tick time. `jobs.yml` is never rewritten** —
  rewriting it would dirty the working tree of the repository the loop commits to, and the
  loop would eventually commit the pace change as if it were its own work.
- **`tick`, `status` and `run` all read through the same resolution**, so `status` can
  never report a schedule or an `enabled` flag the scheduler will not act on.
- **A profile problem never stops the scheduler.** A missing or unreadable `profileFile`,
  a name absent from `profiles:`, a malformed table, an invalid single override — each
  falls back to the job's own values and keeps ticking. Fail toward running: a stopped loop
  is a worse failure than a loop running at its default pace. The condition is visible in
  `profile show`, in `status` (`[unknown-name]`, `[file-missing]`), and in the "Scheduler
  health" card of the `report` page.
- **Strict where a human is watching**: `profile show` / `list` / `set` validate the table
  with `set-job`'s own rules and fail with a message naming the profile, job and field —
  including for an unknown key, so a `schedul:` typo cannot sit there doing nothing.
- A `jobs.yml` with no `profiles:` key behaves exactly as it always has, down to
  byte-identical `status` output.

```bash
pshed profile list                 # eco, fast
pshed profile set eco              # writes "eco" to config.profileFile
pshed profile show --human         # which profile, from where, and what it changes per job
```

## Job guards

A **guard** is an optional cheap shell command in front of a job's Claude launch. On
each due tick — after every other gate (global pause, self-pause, breaker, live pid) —
p-shed runs `guard` (`shell: true`, cwd = the job's `cwd` else `defaults.cwd` else the
repo root, env + `PSHED_JOB_ID` / `PSHED_ROOT`, killed after `guardTimeoutSec`,
default 30 s). The **exit code** is the whole scheduling contract; stdout is kept only
as a human-readable reason (below):

| Exit | Meaning | Effect |
|---|---|---|
| `0` | work exists | launch `claude -p` as usual (log record gains `guarded: true`) |
| `75` | deliberately quiet — no work this slot | skip silently; **not** a failure |
| anything else, or timeout | guard is broken | skip + `consecutiveGuardFailures`+1 → shared breaker |

Why 75: it is `EX_TEMPFAIL` in `sysexits.h` ("temporary failure, try again later") and
no crashing tool emits it by accident — crashes exit 1/2, "not found" is 127. A guard
author writes `exit 75` deliberately, so an accidentally broken guard always surfaces
as an error instead of reading as eternal quiet.

Semantics worth knowing:

- **A quiet guard consumes the schedule slot** (like a usage-limit skip): a daily job
  whose guard said quiet at 09:00 next tries tomorrow — it does not re-poll all day.
- **Two failure counters, one breaker.** Guard errors increment
  `consecutiveGuardFailures` (reset by any healthy guard result); run failures keep
  `consecutiveFailures`. Either reaching `maxConsecutiveFailures` trips the same
  breaker; `reset-breaker` clears both.
- **Quiet is silent**: no history-log line (a minutely job must not write 1440
  lines/day) — freshness is visible in `status` (`lastGuard`, e.g. `quiet 40s ago`).
  `guard-error` and launches do log.
- **The guard can say why, on stdout.** The last non-empty line of a guard's stdout is
  kept as `lastGuard.reason` (whitespace collapsed, capped at 120 chars) and shown in
  `status`: `quiet 40s ago (no work: 3 open, 3 excluded by origin)`. Recorded for all
  three outcomes. *Last* line, not first: `guard: a && b` prints in order, so the last
  line comes from the link that actually decided. A guard that prints nothing stores no
  field and reads exactly as before. This is the only place a quiet slot is explained —
  by design it has no history row.
- `run <id>` respects the guard; `--no-guard` bypasses it. Manual runs stay stateless.
- Windows: the guard runs via `cmd.exe`, where `~` does not expand — use real paths in
  guard commands.

### Guard-only jobs (free scheduled commands)

A job whose guard does the work and exits 75 never launches Claude but keeps full
p-shed supervision (breaker, `status`): in `cmd && exit 75` a failing `cmd`
short-circuits the `&&`, the guard exits with `cmd`'s code, and the breaker path
fires. `prompt` stays required as documentation of what the guard does.

    - id: session-clean
      schedule: "0 4 * * *"
      guard: "node tools/clean.mjs && exit 75"
      prompt: "(guard-only) Nightly cleanup; the guard does the work."

## Staying stuck-safe: circuit breaker + self-pause

Two independent guards stop a broken job from burning a run every minute forever. Both
are cleared with `reset-breaker <id>` (or `/p-shed:reset-breaker`).

- **Circuit breaker (process-level).** p-shed sees the launch's exit: a run is
  *unhealthy* if it timed out or exited non-zero. After `maxConsecutiveFailures`
  unhealthy runs in a row (per-job or `defaults`; default 3, `0` disables), the breaker
  trips — the job is skipped on later ticks (`skipped-breaker`) until reset. A healthy
  run (exit 0) resets the counter. **A Claude usage-limit or a transient API overload
  is not a failure** (see below) — it is a `skipped-usage-limit` that leaves the counter
  untouched, so a quota window can never trip the breaker.
- **Self-pause (task-level).** `claude -p` exits 0 even when the job's *internal* work
  failed (e.g. its own tests went red), which the breaker can't see. So a job's prompt
  can write `run/<id>.pause` (contents = a human-readable reason) to signal "stop
  scheduling me". While that marker exists the job is skipped (`skipped-paused`).

#### Who wrote the marker matters

The same file is written by two very different actors, so it records its **origin**:

| Written by | Contents | Cleared by |
|---|---|---|
| the job itself (`echo "verify went red" > run/<id>.pause`, or a bare `touch`) | the plain reason, no header | `reset-breaker <id>` — un-sticking it is the whole point — or `resume --id` |
| an operator (`pshed pause --id <job>` / `--group <name>`) | `#pshed origin=operator` + the reason | `resume --id` / `--group` **only** |
| `deploy` (holding the loop during maintenance) | `#pshed origin=deploy` + the reason | `deploy`'s own release, or the tick's reclaim once its owner is gone |

An operator `pause` landing on a marker that is currently `deploy`-origin **takes
ownership of it**: origin flips to `operator` and the reason is replaced (when one was
given), so a human's halt set mid-deploy survives that deploy finishing and releasing —
release only ever clears a marker still carrying its own origin. Landing on a `self` or
already-`operator` marker is unchanged: the **first** reason wins.

`reset-breaker` deliberately does **not** lift an operator pause: an unrelated failure
reset must never cancel a halt a human put there on purpose. It reports
`{ pauseCleared: false, operatorPause: true }` and says which command lifts it. The
reason stays plain text in both cases, so `status` (`pauseReason`, and the `paused`
column of `--human`) and the tick's `skipped-paused` keep showing a readable line
rather than a machine blob. Pausing an already-paused job is a no-op that keeps the
**first** reason — the one that explains why the job actually stopped.

### Usage limits and API overload are skips, not failures

When a run fails **only** because the Claude subscription usage limit is exhausted (the
5-hour "session", weekly, Opus, or "out of extra usage" / "out of credits" cases) or
because of a transient API overload (`429`/`529`, `rate_limit_error`, `overloaded_error`),
that is quota/infra — not a code failure. p-shed classifies each finished run and, for
these, records a `skipped-usage-limit` (with a reset time when the message carries one)
that **does not move the breaker counter**. No `reset-breaker` is needed.

**The skip does not consume the job's slot.** `lastRun` is left where it was, so the job
stays due and retries — for every schedule density, not just for a minutely job. It used
to be advanced, which meant a `20 6 * * *` job that came back `api-overload` at 09:05 was
not due again until 06:20 the *next morning*: a transient blip cost a full day. A pending
retry also keeps the job due past `isDue`'s 24-hour catch-up window, so a weekly schedule
does not lose a whole week to a long outage.

Staying due is bounded, so a minutely job cannot hammer a quota that is known to be
exhausted. `retryNotBefore` holds the earliest moment the job may relaunch: the reset time
when the limit message carried a parseable one, otherwise an exponential backoff starting
at one minute and capped at 30. Each further skip raises `consecutiveSkips` and lengthens
the wait; the first real run (success *or* failure), and any guard verdict that consumes
the slot, clears both. A tick held back this way is reported as `skipped-retry-wait` and
writes no state and no history row.

`status` names which of the two states a job is in — `api-overload retry 09:12` while the
backoff is pending, `retry-now` once it has elapsed, and `usage-limit next-slot` for a
skip with no retry outstanding (which is also how a state file written before this feature
reads, correctly: its `lastRun` really was advanced).

Both skip the same way, but they are **reported apart** — the log's `reason` and the
state's `lastSkipReason` are `usage-limit` for a subscription/credits limit and
`api-overload` for a 429/529/5xx, so logs full of overloads can't be misread as a bot
burning through its quota. When a message carries both signatures, subscription wins (it
is the more consequential state, and the one with a reset time).

Claude Code has no distinct exit code or JSON subtype for a usage limit, so detection is
by **message text** (plus a structured-JSON fallback: `is_error` together with an
`api_error_status` / HTTP `429`|`529`). The pattern is customizable — set
`defaults.usageLimitPattern` in `jobs.yml` (a case-insensitive regex) or the
`PSHED_USAGE_LIMIT_PATTERN` env var to override the built-in; `jobs.yml` wins, then env,
then the built-in default. Every **failed** run also logs its truncated raw output and
classification to `logs/<date>.jsonl`, so a limit message the pattern didn't yet cover is
visible there and can be added after at most one breaker trip.

**A non-retryable API error is a failure, not a skip.** Only retryable statuses
(`408`, `429`, `500`, `502`, `503`, `504`, `529`) count as an overload. An `is_error`
result carrying `400` / `401` / `403` — bad request, expired credential, revoked key —
will fail identically on every retry, so it goes down the normal failure path and trips
the breaker like any other broken job, instead of skipping silently forever while
looking healthy.

## Stopping, pausing, and status

Three levers, deliberately distinct:

- **`pause` / `resume` (reversible, cwd-independent).** `pause` drops `run/PAUSED`; the
  next `tick` short-circuits before evaluating any job (`{ "action": "tick", "paused":
  true, "launched": 0 }`) and launches nothing until `resume` deletes the marker. Cron
  stays installed, so this is the right tool to "halt to reconfigure, then resume"
  without re-running `install-cron`. It does not depend on the folder-scoped task id.
  - **Targeted:** `pause --id <job>` halts one job and `pause --group <name>` halts every
    member of one concurrency group (membership resolved exactly like the group gate, so
    a job inheriting `defaults.concurrencyGroup` is included and an explicit
    `concurrencyGroup: null` is not). Each writes that job's `run/<id>.pause`; the tick
    reports `skipped-paused` and every other job keeps running. `resume` takes the same
    flags. The output names what changed — `pausedIds` / `alreadyPausedIds`,
    `resumedIds` / `notPausedIds`.
  - **An unmatched target is an error, not a wider pause.** `--id` and `--group`
    together, an unknown job id, a group no job belongs to, or a flag with no value all
    exit 2 with a validation error and write **nothing**. A typo must never escalate
    "stop this one job" into "stop the whole scheduler".
- **`stop` (teardown).** Removes the OS scheduler entry for this folder — the honest
  `remove-cron` (below) — reporting a `removed` verdict. `stop --kill` additionally
  terminates in-flight jobs: SIGTERM every live pid, then SIGKILL any survivor after a
  short grace period (`--grace-ms`, default 3000), reporting how many were terminated.
- **`status`.** A read-only snapshot: whether the tick is installed (scanned from the OS
  scheduler), the global pause state, and per job — running (live pid), self-paused,
  breaker state (consecutive failures / reason), last run/exit, and the last usage-limit
  skip (`lastSkip` column / `lastSkipReason` field) so a stuck-on-limit job is visible.
  Both the global and per-job pause report a `pauseOrigin` (`self` / `operator` /
  `deploy`) alongside `pauseReason` — without it, a live `deploy` and an operator pause
  someone forgot to `resume` look identical, which is exactly the confusion the origin
  field exists to remove (`reset-breaker` already made this same distinction, reporting
  `deployPause: true`). `--human`'s per-job table gains an `origin` column; the global
  `paused:` line appends `[deploy]` only for a non-operator origin.

### `remove-cron` / `stop` are honest about a cwd mismatch

The scheduler task id is derived from the current folder (`taskName(root)`). Running
`remove-cron`/`stop` from the **wrong** directory used to remove a non-existent entry and
still report success while the real tick kept ticking. Now the teardown diffs the crontab
(or checks the `schtasks` delete result) and reports `removed: false` with a `warning`
plus `installedTaskIds` — the `pshed-*` ids actually registered — so a cwd mismatch is
obvious. The crontab is only rewritten when a line is genuinely removed, so a wrong-dir
run never mutates it.

### The cron line does not pin a plugin version (POSIX)

A plugin is installed into a **versioned** cache directory
(`~/.claude/plugins/cache/perky-team/p-shed/0.10.0/tools/pshed.mjs`), and the plugin
system treats those directories as disposable. Measured on the live Pi on 2026-08-03: the
exact directory the crontab invoked every minute carried an `.orphaned_at` marker, while
the registry listed a *different* version as installed. (Honest scope: orphan markers from
twelve days earlier were still on disk, so no sweep has actually deleted anything. This
removes a dependency that buys nothing; it was never an observed outage.)

So `install-cron` now writes a line that resolves the tool at call time:

```cron
* * * * * cd "/home/me/work" && P=$(ls -d /home/me/.claude/plugins/cache/perky-team/p-shed/*/tools/pshed.mjs 2>/dev/null | sort -V | tail -n 1); "/usr/bin/node" "${P:-/home/me/.claude/plugins/cache/perky-team/p-shed/0.10.0/tools/pshed.mjs}" tick > "/home/me/work/.pshed/logs/cron.log" 2>&1 # pshed-1a2b3c4d
```

- `sort -V` is load-bearing: as plain strings `0.9.0` sorts **after** `0.10.0`, so a bare
  glob would confidently pick the older install.
- `${P:-…}` falls back to the literal path, so the line can only gain a way to work, never
  lose one — including when coreutils are missing from cron's stripped `PATH`.
- A **dev checkout** (`plugins/p-shed/tools/pshed.mjs`, no version segment) gets the old
  literal line, byte for byte. Only the directory directly above `tools/` is treated as a
  version.
- The `# pshed-<sha1>` marker keeps its position and format, so `remove-cron` / `stop`
  still find and remove lines written by **older** p-shed versions.

Ruled out on evidence, not by omission: resolving through
`~/.claude/plugins/installed_plugins.json` is the most "correct"-sounding option, but that
is the file that was *wrong* in the measured case — it named 0.9.0 while 0.10.0 was the
one actually running.

**Windows keeps the pinned path**, deliberately: the incident is Linux-only, batch has no
version-aware sort (`dir /o-n` would pick 0.9.0 over 0.10.0 — a confidently wrong answer is
worse than a pinned one), and a `node -e` resolver inside `schtasks /TR` inside `cmd /c` is
three layers of quoting plus schtasks' own `%` handling for a risk never observed there.

## Looking at the loop from a phone

`pshed report` only prints a page. Serving it is up to you — p-shed has no HTTP server
and will not grow one.

Render it on a schedule with a guard-only job, so a broken render trips the breaker
instead of failing silently. There is no `pshed` on `PATH` — point the guard at the real
path to `pshed.mjs`, the same way `install-cron` does (see above):

    - id: board
      schedule: "*/5 * * * *"
      cwd: "."
      guard: "node /path/to/p-shed/tools/pshed.mjs report --out /home/me/board/index.html && exit 75"
      prompt: "(guard-only) Render the board."

Create `/home/me/board` before you add the job — `report` writes a file, not a folder,
so the folder has to exist first. Then point any static file server at it. With caddy:

    :8080 {
        root * /home/me/board
        file_server
        basicauth { me <bcrypt-hash> }
    }

Three things worth getting right the first time:

- **Keep the output folder owned by the user the loop runs as** (`/home/me/board`), not
  `/var/www`. A permission error inside a guard is a bad place to debug.
- **Do not skip the password.** The page shows job prompts, pause reasons, and the tail
  of a failed run's output. On a home network, everyone on it can read that.
- **The page is only as fresh as the job that wrote it.** It carries the time it was
  generated, in the header — that stamp is how a dead render job becomes visible.

Reaching it from outside your own network needs a tunnel you set up yourself. Nothing
here blocks that, and nothing here helps.

## Known limitations

- A job runs in its `cwd`; only that folder's `.claude/rules` load. To target another
  project, set the job's `cwd` there (its own setup takes over) or put full
  instructions in the prompt.
- Requires the OS scheduler (`schtasks` on Windows, user `crontab` on Linux/macOS) and
  `node` + `claude` resolvable at install time.
- **The report covers only the last 7 days.** That is a fixed property of the report
  page itself, not of `logs/` — but the report can never show more than `logs/` still
  holds, so setting `defaults.logRetentionDays` below 7 shortens the report too. Raising
  it above 7 keeps more raw history on disk (useful for your own tooling) without
  changing what the built-in report displays.
- **Windows: the tick runs in your interactive session.** A brief console window may
  appear each minute, and jobs run only while you are logged on. Running hidden and
  when logged off needs a Task Scheduler "run whether logged on or not" (S4U) entry,
  which requires admin rights — out of scope for the simple `schtasks` installer here.
- **Windows: keep prompts to plain text.** Each launch goes through `cmd.exe`, so a
  prompt containing raw shell metacharacters — especially `%NAME%` (environment-
  variable expansion), and `&`/`|`/`<`/`>` in a prompt with no surrounding spaces — can
  be mangled before it reaches `claude`. Ordinary sentence prompts are unaffected.
- **Windows: `deploy` command arguments containing `%VAR%`.** On Windows, commands run through `cmd.exe`, which expands `%VAR%` even inside double quotes. A deployed command with arguments like `set KEY=%SOMETHING%` will have `%SOMETHING%` expanded by the shell before the command sees it. This is inherent to needing a shell for `.cmd` shims and cannot be fixed in the quoting.
