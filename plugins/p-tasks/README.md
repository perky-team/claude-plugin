# p-tasks

A Claude Code plugin that tracks tasks (`task` → `sub-task`) with `todo`/`in_progress`/`done` statuses and blocker relationships. Data lives in `docs/tasks/tasks.yml`, in Jira, or in both (one-way primary → mirrors sync).

Distributed via the [`perky.team`](../../) marketplace.

## Install

```text
/plugin marketplace add perky-team/claude-plugin
/plugin install p-tasks@perky.team
```

## Local development

```bash
claude --plugin-dir C:/path/to/claude-plugin/plugins/p-tasks
```

After edits, `/reload-plugins` inside Claude Code picks them up without restart.

## Commands

| Command | What it does |
|---|---|
| `/p-tasks:init` | Scaffolds `docs/tasks/` and a global rule at `.claude/rules/p-tasks.md`. Prompts for FS or Jira primary; optional mirror. |
| `/p-tasks:add` | Creates a task or sub-task with optional description and blockers. |
| `/p-tasks:set` | Updates status, title, description, or blocker list (full replace or incremental). |
| `/p-tasks:next` | Returns the most relevant unblocked item (in-progress first; sub-tasks of in-progress parents first). |
| `/p-tasks:summary` | Lists done top-level tasks; with a task id — done sub-tasks of that task. |
| `/p-tasks:sync` | Pushes primary state to all mirrors. Idempotent. |

## Jira setup

Required env vars (never on disk):
- `PTASKS_JIRA_EMAIL`
- `PTASKS_JIRA_TOKEN`

Generate the API token at https://id.atlassian.com/manage-profile/security/api-tokens.

## Design

See [`docs/superpowers/specs/2026-05-20-p-tasks-plugin-design.md`](./docs/superpowers/specs/2026-05-20-p-tasks-plugin-design.md) and [`docs/superpowers/plans/2026-05-20-p-tasks-plugin.md`](./docs/superpowers/plans/2026-05-20-p-tasks-plugin.md).

## Validate

```bash
node scripts/validate.mjs                                                  # from repo root
npm test -- plugins/p-tasks                                                # run only p-tasks tests
```
