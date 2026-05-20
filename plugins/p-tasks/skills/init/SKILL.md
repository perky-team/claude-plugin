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

If `jira`:
- Verify `PTASKS_JIRA_EMAIL` and `PTASKS_JIRA_TOKEN`; if missing, link to https://id.atlassian.com/manage-profile/security/api-tokens and stop.
- Ask: site URL (e.g. `https://example.atlassian.net`).
- Ask: project key (e.g. `PROJ`).
- Confirm/override issue types defaults (`Task` / `Sub-task`).

## Step 3 — Mirror? (optional)

Ask: "Add a mirror? `none` (default) / `fs` / `jira`."

If a Jira mirror is requested, collect site + project (same as Step 2) for the mirror.

## Step 4 — Invoke CLI

```
node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" init [--primary fs|jira] [--mirror fs|jira] [--site=...] [--project=...] [--task-type=...] [--sub-task-type=...] --json
```

Report the printed JSON. On `auth-failed` or `config-invalid`, explain to the user and stop.
