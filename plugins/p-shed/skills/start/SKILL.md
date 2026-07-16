---
name: start
description: Install the OS scheduler entry that runs `pshed tick` every minute in this folder (Windows schtasks, Linux/macOS crontab). Use when the user says "start p-shed", "enable the scheduler", or "begin running jobs".
argument-hint: (no arguments)
allowed-tools: Bash(node:*) Read
---

# /p-shed:start

## Step 1 — Require initialization
If `.pshed/` does not exist in the current folder, stop and say: "Run `/p-shed:init` first." Do NOT auto-scaffold.

## Step 2 — Install the scheduler entry
Run:
    node "${CLAUDE_PLUGIN_ROOT}/tools/pshed.mjs" install-cron --json
Report the printed JSON (`scheduler`, `task`, `action`). This registers `pshed tick` to run every minute in this folder; it is idempotent.

## Step 3 — Report
Tell the user the scheduler is active and that `/p-shed:stop` removes it.
