---
name: job
description: Add, modify, or delete a scheduled job in `.pshed/jobs.yml` (cron schedule + folder + prompt). Use when the user says "add a job", "schedule a run", "change the schedule", "disable a job", or "delete a job".
argument-hint: --schedule <cron> --prompt <text> [--id <id>]
allowed-tools: Bash(node:*) Read
---

# /p-shed:job

Manage one scheduled job. A job is a timer: **when** (cron), **where** (`cwd`), **what** (`prompt`).

## Add or modify
Collect: cron `schedule` (validate the 5-field form), the `prompt`, optional `cwd`
(defaults to `.`), optional `timeoutSec`/`permissionMode`/`allowedTools`. To modify an
existing job, pass its `--id`. Run:
    node "${CLAUDE_PLUGIN_ROOT}/tools/pshed.mjs" set-job --schedule "<cron>" --prompt "<text>" [--id <id>] [--cwd <path>] [--timeoutSec <n>] [--permission-mode <mode>] [--allowed-tools "<list>"] --json
On exit code 2 (`error.code = validation`), show the message (e.g. bad cron) and ask again.

## Delete
    node "${CLAUDE_PLUGIN_ROOT}/tools/pshed.mjs" rm-job --id <id> --json
Report whether it was removed.

## Report
Echo the resulting job id and that changes take effect on the next tick.
