# p-shed — design spec

**Date:** 2026-07-16
**Status:** approved for planning
**Plugin:** `p-shed` (tool `pshed`)

## Summary

`p-shed` is a **pure scheduler / launcher** for Claude Code CLI headless runs. It
schedules jobs and, on each due tick, launches `claude -p "<prompt>"` in a job's
folder. It does **not** manage work items, task stores, or any playbook — where the
work comes from and what to do is entirely defined by each job's `prompt` and by the
target folder's own setup (its `.claude/rules`, its p-tasks, etc.).

This scope is deliberately narrower than the original brief. During brainstorming we
established that once a job simply launches Claude in a folder, the folder's own
project setup already resolves work items, so p-shed needs neither a shared dual-mode
task-store component nor its own work-item file. Those were dropped.

## Non-goals (explicitly out of scope)

- **No task storage.** No `worklist.yml`, no dual-mode resolution, no reading/writing
  of p-tasks. p-shed never stores or resolves work items.
- **No shared task-store component.** The original "Part A" (extract p-flow's dual-mode
  convention into a shared source) is removed. p-flow stays as it is.
- **No changes to p-flow.** Zero files touched, zero tests added or modified in p-flow.
- **No playbook rule.** `p-shed:init` writes no `.claude/rules/p-shed.md`. All run
  instructions live in each job's `prompt`.
- **No task deletion / pruning** anywhere.
- **No budget cap. No cross-job lock.** (A per-job duplicate guard is kept — see below.)

## Concept

Two things, kept separate:

- **Job (schedule):** a timer entry — *when* (cron expression), *where* (`cwd`), and
  *what* (`prompt`) to launch. A job does **not** point at any specific task.
- **Work:** whatever the launched `claude -p` run does, driven by its `prompt` and the
  target folder's own configuration. p-shed is blind to it.

The only binding between a job and any project's tasks is **the folder**: a job's `cwd`
selects the repo, and that repo's own setup takes over once Claude launches. Pointing a
job at a specific project is done by setting its `cwd` (clean) or by writing an explicit
path into the `prompt` (flexible).

## Components

### Tool `tools/pshed.mjs` (Node ESM)

Dispatch on `process.argv[2]`. Every command supports `--json`. `--version` prints the
tool version. Exit codes: `0` ok, `1` environment error, `2` validation error. Mirrors
the structure of `plugins/p-tasks/tools/ptasks.mjs`.

Commands:

- **`tick`** — the heartbeat, invoked once per minute by the OS scheduler. Steps:
  1. Rotate logs: delete `logs/*.jsonl` files older than 7 days.
  2. Read `config.json`, `jobs.yml`, `state.json`.
  3. For each **enabled** job:
     - **Due calc + catch-up:** using the job's cron expression and its `state.lastRun`,
       determine whether any scheduled minute falls in `(lastRun, now]`. If one or more
       do, the job is due. Missed ticks run **once** (catch-up, no stacking).
     - **Duplicate guard (NOT a lock):** read `run/<id>.pid`. If that pid is still alive,
       **skip** this job and record `skipped` — do not launch a second run.
     - **Launch:** spawn `claude -p "<prompt>" --output-format json --permission-mode
       <mode> [--allowedTools <list>]` in the job's `cwd`, **non-bare** (so the target
       folder's `.claude/rules` and skills load). Write `run/<id>.pid`.
     - **Timeout:** enforce `timeoutSec`. On expiry, kill the **process tree** — Windows
       `taskkill /PID <pid> /T /F`; POSIX: launch detached in its own process group and
       `kill` the group.
     - **Finalize:** update `state.json` (`lastRun`, `lastExit`, clear `pid`), append a
       record to `logs/<date>.jsonl`, remove the pidfile.
- **`run <job>`** — run one job immediately, bypassing the schedule (manual / testing).
  Same launch/timeout/duplicate-guard path as a due tick.
- **`install-cron` / `remove-cron`** — idempotently register / unregister an OS scheduler
  entry that runs `pshed tick` every minute in the current folder. Branches on
  `process.platform`: `win32` → `schtasks`; otherwise → user `crontab`. Uses absolute
  paths to `node` and the tool, and passes the cron-minimal environment (HOME/USERPROFILE,
  PATH). Re-running is a no-op if the entry already exists.
- **`set-job` / `rm-job`** — add / modify / remove a job in `jobs.yml`, validating the
  cron expression and keeping stable ids. Backed by `js-yaml`. (Same shape as
  `ptasks.mjs add` / `set`.)

Support modules:

- **`tools/lib/cron.mjs`** — a small self-contained 5-field cron matcher (`*`, `*/n`,
  `a-b`, comma lists, single values) plus a "was any scheduled minute due since
  `lastRun`" helper. **Rationale for not using `cron-parser`:** plugins are distributed
  by copying files with no `npm install` step, so every dependency must be vendored;
  `cron-parser` pulls transitive deps (luxon), which is fragile to vendor. Minute-
  granularity matching + catch-up is ~50 lines and needs nothing external. This is a
  deliberate deviation from the brief's "small dep like cron-parser".
- **`scripts/vendor-deps.mjs` + `tools/lib/vendor/js-yaml.mjs`** — vendor `js-yaml` (the
  only runtime dependency), following the p-tasks pattern.

### Skills (`skills/<name>/SKILL.md`)

Frontmatter follows the p-tasks / p-graph convention (name matches dir, description
≥ 30 chars, parseable `allowed-tools`).

- **`p-shed:init`** — one-shot scaffold. Refuse if `.pshed/` already exists. Following the
  **p-graph / p-wiki pattern**, the skill itself (not a CLI command) creates
  `.pshed/config.json`, an empty `jobs.yml`, `state.json`, the `logs/` and `run/`
  directories, and appends the gitignore lines. **Writes no rule file.**
- **`p-shed:start`** — if `.pshed/` is absent, politely say "run `p-shed:init` first" and
  exit (do **not** auto-scaffold). Otherwise `pshed install-cron`.
- **`p-shed:stop`** — `pshed remove-cron`.
- **`p-shed:job`** — add / modify / delete a schedule via `pshed set-job` / `rm-job`.
  (Renamed from the brief's `p-shed:add`, which mislabeled a CRUD skill as add-only.)

## Data formats (`.pshed/`)

| File | Tracked? | Contents |
|---|---|---|
| `config.json` | git | defaults: `permissionMode`, `timeoutSec`, `allowedTools`, `nodeBin`, `claudeBin` |
| `jobs.yml` | git | `version`, `defaults`, `jobs[]{ id, schedule, enabled, cwd, prompt, timeoutSec?, permissionMode?, allowedTools? }` |
| `state.json` | gitignore | per-job `{ lastRun, lastExit, pid }` — overwritten, does not grow |
| `logs/<date>.jsonl` | gitignore | one record per run `{ ts, job, exit, durationMs, timedOut, skipped }`; auto-rotated (7-day retention) |
| `run/<id>.pid` | gitignore | duplicate-guard pidfile |

Example `jobs.yml`:

```yaml
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
```

## Design rationale (key decisions)

- **Timeout is mandatory, not optional.** Because runs are unattended AND the duplicate
  guard skips launching while a previous run is alive, a hung run would wedge the job
  forever (every tick sees the live pid and skips). The timeout is the self-recovery
  mechanism: it kills the hung process tree, the pidfile clears, and the next tick can
  start fresh. It is configurable per job (default 900s) so long-running jobs raise it.
- **Duplicate guard, not a lock.** Per-job pidfile only. No cross-job lock — independent
  jobs may run concurrently.
- **Catch-up runs once.** A job that missed several scheduled minutes (machine asleep,
  scheduler paused) runs a single catch-up, never a backlog burst.
- **Cross-OS scheduling.** One skill/command surface; the tool picks `schtasks` on
  Windows and `crontab` elsewhere, handling absolute paths and cron-minimal env inside.
- **Rule placement caveat (documented limitation).** A job's `cwd` determines which
  folder's `.claude/rules` load. If a job targets a folder other than where its work
  conventions live, those conventions must exist in that folder (or be inlined into the
  prompt). p-shed does not install anything into target folders.

## Testing (vitest, repo idiom)

- Every `SKILL.md` has valid frontmatter; every skill is referenced in
  `plugins/p-shed/README.md`.
- `cron.mjs`: field matching; "due since lastRun"; catch-up collapses missed ticks to a
  single run.
- Duplicate guard: a live pid yields `skipped`; the launch command line and the
  process-tree kill are exercised via a mocked `spawn`.
- Log rotation: files older than 7 days are removed.
- **p-flow is not touched — no p-flow tests are added or modified.**

## Acceptance

- `p-shed:init` → `p-shed:start` → `p-shed:job` works end-to-end.
- `pshed tick` launches `claude -p` for a due job, respects the timeout, and skips a
  still-running job.
- Logs do not grow without bound (7-day rotation).
- Every created file is in English. Commands are documented in `plugins/p-shed/README.md`.
