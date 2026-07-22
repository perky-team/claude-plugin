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

Tool: `node tools/pshed.mjs <command>` (all support `--json`; exit `0` ok / `1` env / `2` validation):

| Command | Purpose |
|---|---|
| `tick` | Cron entry point — run every due job once. Invoked by the OS scheduler each minute. |
| `run <id>` | Run one job immediately, bypassing the schedule (manual/testing). |
| `set-job` | Add or modify a job (`--schedule`, `--prompt`, `--id`, `--cwd`, `--timeoutSec`, `--permission-mode`, `--allowed-tools`, `--model`, `--effort`, `--max-consecutive-failures`). |
| `rm-job` | Delete a job (`--id`). |
| `reset-breaker <id>` | Clear a job's tripped circuit breaker and self-pause marker so it schedules again. |
| `pause` / `resume` | Reversibly halt / resume the **whole** scheduler (`run/PAUSED`; cron stays installed). `pause` accepts `--reason`; both idempotent. |
| `status` | Report, from disk + the OS scheduler: installed?, globally paused?, and per job running/paused/breaker/last-run. JSON by default, `--human` for a text table. |
| `stop` `[--kill]` | Honest teardown of the OS scheduler entry — reports `removed: true|false` (see below). `--kill` also SIGTERM→SIGKILLs any in-flight jobs (`--grace-ms` tunes the escalation delay). |
| `install-cron` / `remove-cron` | Register/unregister the every-minute `tick` in the OS scheduler for this folder. `remove-cron` reports `removed` and warns on a cwd mismatch (see below). |

## Formats

`.pshed/` layout:

| File | Tracked? | Contents |
|---|---|---|
| `jobs.yml` | git | `version`, `defaults`, `jobs[]{ id, schedule, enabled, cwd?, prompt, timeoutSec?, permissionMode?, allowedTools?, model?, effort?, maxConsecutiveFailures? }` |
| `config.json` | gitignore | `{ nodeBin, claudeBin }` (resolved at init) |
| `state/<id>.json` | gitignore | per-job `{ lastRun, lastExit, pid, consecutiveFailures, breakerTripped?, breakerReason?, breakerAt?, lastSkipReason?, lastSkipAt?, lastSkipResetAt? }` — one file per job (no shared state file). `lastSkip*` records the most recent usage-limit skip and is cleared once the job runs for real again |
| `logs/<date>.jsonl` | gitignore | one record per run; auto-rotated (7-day retention) |
| `run/<id>.pid` | gitignore | duplicate-guard pidfile |
| `run/<id>.pause` | gitignore | per-job self-pause marker (contents = reason); a job's own run writes it to stop being scheduled |
| `run/PAUSED` | gitignore | global pause marker (`{ createdAt, reason? }`); halts every job while cron stays installed. Written by `pause`, removed by `resume` |

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

### Usage limits and API overload are skips, not failures

When a run fails **only** because the Claude subscription usage limit is exhausted (the
5-hour "session", weekly, Opus, or "out of extra usage" / "out of credits" cases) or
because of a transient API overload (`429`/`529`, `rate_limit_error`, `overloaded_error`),
that is quota/infra — not a code failure. p-shed classifies each finished run and, for
these, records a `skipped-usage-limit` (with a reset time when the message carries one)
that **does not move the breaker counter**. The next scheduled tick simply retries when
the window resets; no `reset-breaker` is needed. `status` shows a job's last skip in the
`lastSkip` column so a stuck-on-limit job is visible.

Claude Code has no distinct exit code or JSON subtype for a usage limit, so detection is
by **message text** (plus a structured-JSON fallback: `is_error` together with an
`api_error_status` / HTTP `429`|`529`). The pattern is customizable — set
`defaults.usageLimitPattern` in `jobs.yml` (a case-insensitive regex) or the
`PSHED_USAGE_LIMIT_PATTERN` env var to override the built-in; `jobs.yml` wins, then env,
then the built-in default. Every **failed** run also logs its truncated raw output and
classification to `logs/<date>.jsonl`, so a limit message the pattern didn't yet cover is
visible there and can be added after at most one breaker trip.

## Stopping, pausing, and status

Three levers, deliberately distinct:

- **`pause` / `resume` (reversible, cwd-independent).** `pause` drops `run/PAUSED`; the
  next `tick` short-circuits before evaluating any job (`{ "action": "tick", "paused":
  true, "launched": 0 }`) and launches nothing until `resume` deletes the marker. Cron
  stays installed, so this is the right tool to "halt to reconfigure, then resume"
  without re-running `install-cron`. It does not depend on the folder-scoped task id.
- **`stop` (teardown).** Removes the OS scheduler entry for this folder — the honest
  `remove-cron` (below) — reporting a `removed` verdict. `stop --kill` additionally
  terminates in-flight jobs: SIGTERM every live pid, then SIGKILL any survivor after a
  short grace period (`--grace-ms`, default 3000), reporting how many were terminated.
- **`status`.** A read-only snapshot: whether the tick is installed (scanned from the OS
  scheduler), the global pause state, and per job — running (live pid), self-paused,
  breaker state (consecutive failures / reason), last run/exit, and the last usage-limit
  skip (`lastSkip` column / `lastSkipReason` field) so a stuck-on-limit job is visible.

### `remove-cron` / `stop` are honest about a cwd mismatch

The scheduler task id is derived from the current folder (`taskName(root)`). Running
`remove-cron`/`stop` from the **wrong** directory used to remove a non-existent entry and
still report success while the real tick kept ticking. Now the teardown diffs the crontab
(or checks the `schtasks` delete result) and reports `removed: false` with a `warning`
plus `installedTaskIds` — the `pshed-*` ids actually registered — so a cwd mismatch is
obvious. The crontab is only rewritten when a line is genuinely removed, so a wrong-dir
run never mutates it.

## Known limitations

- A job runs in its `cwd`; only that folder's `.claude/rules` load. To target another
  project, set the job's `cwd` there (its own setup takes over) or put full
  instructions in the prompt.
- Requires the OS scheduler (`schtasks` on Windows, user `crontab` on Linux/macOS) and
  `node` + `claude` resolvable at install time.
- **Windows: the tick runs in your interactive session.** A brief console window may
  appear each minute, and jobs run only while you are logged on. Running hidden and
  when logged off needs a Task Scheduler "run whether logged on or not" (S4U) entry,
  which requires admin rights — out of scope for the simple `schtasks` installer here.
- **Windows: keep prompts to plain text.** Each launch goes through `cmd.exe`, so a
  prompt containing raw shell metacharacters — especially `%NAME%` (environment-
  variable expansion), and `&`/`|`/`<`/`>` in a prompt with no surrounding spaces — can
  be mangled before it reaches `claude`. Ordinary sentence prompts are unaffected.
