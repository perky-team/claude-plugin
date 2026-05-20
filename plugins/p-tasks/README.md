# p-tasks

A Claude Code plugin that tracks tasks (`task` → `sub-task`) with `todo`/`in_progress`/`done` statuses and blocker relationships. Data lives in a local `docs/tasks/tasks.yml`, in Jira, or in both (one-way primary→mirrors sync).

Distributed via the `perky.team` marketplace.

## Install

```text
/plugin marketplace add perky-team/claude-plugin
/plugin install p-tasks@perky.team
```

## Commands

| Command | What it does |
|---|---|
| `/p-tasks:init` | Scaffolds `docs/tasks/` and a global rule at `.claude/rules/p-tasks.md`. |
| `/p-tasks:add` | Creates a task or sub-task. |
| `/p-tasks:set` | Updates status, title, description, or blockers. |
| `/p-tasks:next` | Returns the next unblocked item to work on. |
| `/p-tasks:summary` | Lists done tasks (or done sub-tasks of a given task). |
| `/p-tasks:sync` | One-way sync from primary destination to every mirror. |

## Design

See [`docs/superpowers/specs/2026-05-20-p-tasks-plugin-design.md`](./docs/superpowers/specs/2026-05-20-p-tasks-plugin-design.md).
