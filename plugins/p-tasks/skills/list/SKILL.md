---
name: list
description: |
  List every item in document order with its status and fields — the whole plan, not just open (`next`) or done (`summary`). With a task id, lists that task's sub-tasks in order. Use when the user says "list tasks", "show the whole plan", "what's the full task list", "walk all steps".
argument-hint: "[<task-id>]"
allowed-tools: Bash(node:*) Read
---

# /p-tasks:list

Returns ALL items (regardless of status), filling the gap between `next` (open only) and `summary` (done only) so a consumer can walk the entire plan in order.

## Step 1 — Resolve scope

If the user named a specific task (by title or id), find its id to scope the listing to that task's sub-tasks. Otherwise list the whole project.

## Step 2 — Invoke CLI

```
node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" list [<task-id>] --json
```

Each item carries `id`, `type`, `title`, `status`, and — when set — `parentId`, `description`, `acceptance`, `files`, `kind`, `origin`, `resolution`, and `blockedBy`.

## Step 3 — Render

Present the items in order. Group sub-tasks under their parent task, show each item's status, and surface `acceptance` / `kind` / `origin` when the user is walking the plan to decide what to do next. End with a count of items by status.
