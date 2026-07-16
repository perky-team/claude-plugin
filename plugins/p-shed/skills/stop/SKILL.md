---
name: stop
description: Remove the OS scheduler entry that runs `pshed tick` for this folder. Use when the user says "stop p-shed", "disable the scheduler", or "pause the jobs".
argument-hint: (no arguments)
allowed-tools: Bash(node:*) Read
---

# /p-shed:stop

## Step 1 — Remove the scheduler entry
Run:
    node "${CLAUDE_PLUGIN_ROOT}/tools/pshed.mjs" remove-cron --json
Report the printed JSON. This is idempotent — removing an absent entry is fine.
