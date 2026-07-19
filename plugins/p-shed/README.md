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
| `set-job` | Add or modify a job (`--schedule`, `--prompt`, `--id`, `--cwd`, `--timeoutSec`, `--permission-mode`, `--allowed-tools`, `--model`, `--max-consecutive-failures`). |
| `rm-job` | Delete a job (`--id`). |
| `reset-breaker <id>` | Clear a job's tripped circuit breaker and self-pause marker so it schedules again. |
| `install-cron` / `remove-cron` | Register/unregister the every-minute `tick` in the OS scheduler for this folder. |

## Formats

`.pshed/` layout:

| File | Tracked? | Contents |
|---|---|---|
| `jobs.yml` | git | `version`, `defaults`, `jobs[]{ id, schedule, enabled, cwd?, prompt, timeoutSec?, permissionMode?, allowedTools?, model?, maxConsecutiveFailures? }` |
| `config.json` | gitignore | `{ nodeBin, claudeBin }` (resolved at init) |
| `state/<id>.json` | gitignore | per-job `{ lastRun, lastExit, pid, consecutiveFailures, breakerTripped?, breakerReason?, breakerAt? }` — one file per job (no shared state file) |
| `logs/<date>.jsonl` | gitignore | one record per run; auto-rotated (7-day retention) |
| `run/<id>.pid` | gitignore | duplicate-guard pidfile |
| `run/<id>.pause` | gitignore | self-pause marker (contents = reason); a job's own run writes it to stop being scheduled |

Example `jobs.yml`:

    version: 1
    defaults:
      cwd: "."
      timeoutSec: 900
      permissionMode: acceptEdits
      allowedTools: "Read,Write,Edit,Bash(git *)"
      model: sonnet
      maxConsecutiveFailures: 3
    jobs:
      - id: task-runner
        schedule: "*/15 * * * *"
        enabled: true
        prompt: "Take the next unblocked work item in this repo and complete it."

## Model selection

Set `model` on a job (or on `defaults`) to pass `--model <name>` to `claude` for that
run; a per-job `model` overrides `defaults.model`. Omit it to use the caller's default
model. Any name `claude --model` accepts works (e.g. `sonnet`, `opus`, `haiku`).

## Staying stuck-safe: circuit breaker + self-pause

Two independent guards stop a broken job from burning a run every minute forever. Both
are cleared with `reset-breaker <id>` (or `/p-shed:reset-breaker`).

- **Circuit breaker (process-level).** p-shed sees the launch's exit: a run is
  *unhealthy* if it timed out or exited non-zero. After `maxConsecutiveFailures`
  unhealthy runs in a row (per-job or `defaults`; default 3, `0` disables), the breaker
  trips — the job is skipped on later ticks (`skipped-breaker`) until reset. A healthy
  run (exit 0) resets the counter.
- **Self-pause (task-level).** `claude -p` exits 0 even when the job's *internal* work
  failed (e.g. its own tests went red), which the breaker can't see. So a job's prompt
  can write `run/<id>.pause` (contents = a human-readable reason) to signal "stop
  scheduling me". While that marker exists the job is skipped (`skipped-paused`).

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
