---
name: summary
description: |
  Summarize completed work. Without an id — all done top-level tasks. With a task id — done sub-tasks of that task. Use when the user says "summary", "what's done", "what did we ship on X", "саммари сделанного".
argument-hint: [<task-id>]
allowed-tools: Bash(node:*) Read
---

# /p-tasks:summary

## Step 1 — Resolve scope

If the user named a specific task (by title or id), find its id. Otherwise summarize the whole project.

## Step 2 — Invoke CLI

```
node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" summary [<task-id>] --json
```

## Step 3 — Synthesize prose

Take the structured list and produce a short natural-language rollup. List each done item by title; include description when present. End with a count.
