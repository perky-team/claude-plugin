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

## Commands

Tool: `node tools/pshed.mjs <command>` (all support `--json`; exit `0` ok / `1` env / `2` validation):

| Command | Purpose |
|---|---|
| `tick` | Cron entry point — run every due job once. Invoked by the OS scheduler each minute. |
| `run <id>` | Run one job immediately, bypassing the schedule (manual/testing). |
| `set-job` | Add or modify a job (`--schedule`, `--prompt`, `--id`, `--cwd`, `--timeoutSec`, `--permission-mode`, `--allowed-tools`). |
| `rm-job` | Delete a job (`--id`). |
| `install-cron` / `remove-cron` | Register/unregister the every-minute `tick` in the OS scheduler for this folder. |

## Formats

`.pshed/` layout:

| File | Tracked? | Contents |
|---|---|---|
| `jobs.yml` | git | `version`, `defaults`, `jobs[]{ id, schedule, enabled, cwd?, prompt, timeoutSec?, permissionMode?, allowedTools? }` |
| `config.json` | gitignore | `{ nodeBin, claudeBin }` (resolved at init) |
| `state/<id>.json` | gitignore | per-job `{ lastRun, lastExit, pid }` — one file per job (no shared state file) |
| `logs/<date>.jsonl` | gitignore | one record per run; auto-rotated (7-day retention) |
| `run/<id>.pid` | gitignore | duplicate-guard pidfile |

Example `jobs.yml`:

    version: 1
    defaults:
      cwd: "."
      timeoutSec: 900
      permissionMode: acceptEdits
      allowedTools: "Read,Write,Edit,Bash(git *)"
    jobs:
      - id: task-runner
        schedule: "*/15 * * * *"
        enabled: true
        prompt: "Take the next unblocked work item in this repo and complete it."

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
