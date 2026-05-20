---
name: sync
description: |
  Push primary destination state to every configured mirror. One-way primary → mirrors, idempotent. Use when the user says "sync tasks", "push to jira", "pull from jira", "синхронизируй задачи".
argument-hint: (no arguments)
allowed-tools: Bash(node:*) Read
---

# /p-tasks:sync

## Step 1 — Run sync

```
node "${CLAUDE_PLUGIN_ROOT}/tools/ptasks.mjs" sync --json
```

## Step 2 — Render result

For each entry in the `mirrors` array, report: mirror name, created/updated/links counts, any warnings, any errors. If there were errors, explain to the user that those mirrors may be in a partial state and `sync` can be re-run safely (idempotent).
