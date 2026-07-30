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
(defaults to `.`), optional `timeoutSec`/`permissionMode`/`allowedTools`, optional
`model` (passed to `claude --model`), optional `effort` (reasoning-effort level passed
to `claude --effort`; one of `low|medium|high|xhigh`; omitted ⇒ claude's default;
ignored for Haiku models), optional `maxConsecutiveFailures` (circuit breaker
threshold; default 3, `0` disables), optional `guard` (a shell command run before each
due launch: exit 0 ⇒ launch, exit 75 ⇒ quiet skip, anything else ⇒ guard error counting
toward the breaker; pass `--guard ""` to clear), and optional `guardTimeoutSec`
(seconds before the guard is killed; default 30). To modify an existing job, pass its `--id`. Run:
    node "${CLAUDE_PLUGIN_ROOT}/tools/pshed.mjs" set-job --schedule "<cron>" --prompt "<text>" [--id <id>] [--cwd <path>] [--timeoutSec <n>] [--permission-mode <mode>] [--allowed-tools "<list>"] [--model <name>] [--effort <low|medium|high|xhigh>] [--max-consecutive-failures <n>] [--guard "<cmd>"] [--guard-timeout-sec <n>] --json
On exit code 2 (`error.code = validation`), show the message (e.g. bad cron) and ask again.

## Delete
    node "${CLAUDE_PLUGIN_ROOT}/tools/pshed.mjs" rm-job --id <id> --json
Report whether it was removed.

## Report
Echo the resulting job id and that changes take effect on the next tick.
