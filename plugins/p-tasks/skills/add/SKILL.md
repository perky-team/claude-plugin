---
name: add
description: |
  Create a task or sub-task in this repo's p-tasks list. Use when the user says "add task", "new sub-task", "create task", or describes work that should be tracked.
argument-hint: <task|sub-task> [<parent-id>] [--title ...] [--description ...] [--blocked-by ...]
allowed-tools: Bash(node:*) Read
---

# /p-tasks:add

You create a new item via the bundled CLI.

## Step 1 — Resolve missing fields conversationally

Required fields:
- Type: `task` or `sub-task`. Infer from the user's wording ("a feature" → task, "a sub-step" → sub-task) or ask.
- For `sub-task`: the parent task id (`t-N`). Ask if missing.
- Title: ask if missing.

Optional fields the user may mention:
- Description (free-form)
- Blockers: a list of ids (e.g. `t-3, st-5`).

## Step 2 — Invoke CLI

```
node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" add <type> [<parent-id>] --title "..." [--description "..."] [--blocked-by id1,id2] --json
```

## Step 3 — Render outcome

On success, tell the user the assigned id and a one-line confirmation.
On `blocker-not-found` / `parent-not-found` / `cycle-detected`: explain the error in plain language and stop.
