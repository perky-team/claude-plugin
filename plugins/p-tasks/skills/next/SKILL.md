---
name: next
description: |
  Return the most relevant unblocked item to work on next. Use when the user says "next task", "what should I work on", "что делать дальше", or asks to be assigned the next thing.
argument-hint: [--all]
allowed-tools: Bash(node:*) Read
---

# /p-tasks:next

## Step 1 — Choose breadth

By default the command returns one item. If the user asks for "the whole list" or "everything I could do", pass `--all`.

## Step 2 — Invoke CLI

```
node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" next [--all] --json
```

## Step 3 — Render

If `{next: null}` or empty `items`: tell the user nothing is unblocked.
Otherwise: identify the item by id + title, mention its status, and (for sub-tasks) the parent.
