---
name: init
description: |
  Initialize p-tasks at `docs/tasks/` of the current git repo. Use when the user says "init p-tasks", "create task list", "setup task tracking", or asks to start tracking tasks in this repo.
argument-hint: (no arguments)
allowed-tools: Bash(git rev-parse:*) Bash(mkdir:*) Bash(test:*) Bash(node:*) Read Write
---

# /p-tasks:init

You are scaffolding the `p-tasks` tracker inside the current repo.

## Step 0 — Verify Node 18+

Run `node --version`. Fail and stop if it's <18.

## Step 1 — Pre-flight

Check if `docs/tasks/.ptasks.json` exists. If yes, stop and tell the user: "p-tasks already initialized here. Edit `.ptasks.json` directly to change destinations, or remove it and re-run `/p-tasks:init`." Do not proceed.

## Step 2 — Choose primary destination

Ask: "Where should tasks live? `fs` (default — local `tasks.yml`) or `jira`?"

If `fs`: invoke `node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" init`. Report the printed JSON.

If `jira`: (Task 27 wires this path — for FS-only initial release, tell the user "Jira primary not yet supported; please choose fs.")
