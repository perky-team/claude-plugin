# p-shed

Scheduler/launcher for Claude Code headless runs. `p-shed` schedules **jobs** (cron
timer + folder + prompt) and, on each due minute, launches `claude -p` in the job's
folder. It is a pure scheduler: it does not store or resolve work items and installs
no rules — what to do lives entirely in each job's prompt and in the target folder.

## Skills

| Skill | Purpose |
|---|---|
| `p-shed:init` | Scaffold `.pshed/` in the current folder. |
| `p-shed:start` | Install the every-minute OS scheduler entry (`pshed tick`). |
| `p-shed:stop` | Remove the OS scheduler entry. |
| `p-shed:job` | Add, modify, or delete a scheduled job. |

## Commands

_Filled in Task 11._

## Formats

_Filled in Task 11._

## Known limitations

- A job runs in its `cwd`; only that folder's `.claude/rules` load. To target another
  project, set the job's `cwd` there (its own setup takes over) or put full
  instructions in the prompt.
- Requires the OS scheduler (`schtasks` on Windows, user `crontab` on Linux/macOS) and
  `node` + `claude` resolvable at install time.
