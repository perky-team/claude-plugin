---
name: set
description: |
  Update a task or sub-task: change status, title, description, or blocker list. Use when the user says "mark X done", "set status", "add blocker to X", "unblock X", "rename X".
argument-hint: <id> [--status todo|in_progress|done] [--title ...] [--description ...] [--blocked-by ...] [--add-blocker ...] [--remove-blocker ...]
allowed-tools: Bash(node:*) Read
---

# /p-tasks:set

You update an existing item.

## Step 1 — Resolve target id

If the user named the item by title rather than id, list candidates by calling `ptasks summary --json` (with optional parent filter) and pick the matching id. If ambiguous, ask.

## Step 2 — Build the patch

Translate the user's request into one or more flags:
- "mark done" → `--status done`
- "start working on it" → `--status in_progress`
- "blocked by X" → `--add-blocker X`
- "no longer blocked by X" → `--remove-blocker X`
- "rename to Y" → `--title "Y"`

## Step 3 — Invoke CLI

```
node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" set <id> [flags] --json
```

## Step 4 — Render outcome

Confirm in one line. On `cycle-detected`, explain which path forms the cycle. On `invalid-status` or `blocker-not-found`, explain.
