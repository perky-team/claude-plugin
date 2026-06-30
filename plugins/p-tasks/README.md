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
| `/p-tasks:list` | Lists ALL items in document order with their status and fields (the whole plan); with a task id — that task's sub-tasks. Fills the gap between `next` (open only) and `summary` (done only). |
| `/p-tasks:sync` | Pushes primary state to all mirrors. Idempotent. |

## Item fields

Each `task` / `sub-task` carries the required `id`, `title`, `description`, `status`, and `blockedBy`. Sub-tasks may also carry these **optional** work-item fields (all default to empty/absent, so existing `tasks.yml` files stay valid):

| Field | Type | Meaning |
|---|---|---|
| `acceptance` | string | the step's acceptance criterion |
| `files` | string[] | expected affected files |
| `kind` | `code` \| `non-code` | execution classification (consumers treat an absent value as `code`) |
| `origin` | string | provenance: `plan` (default), `code-review:<severity>`, `task-review:<severity>` |
| `resolution` | string | evidence-based reason recorded when a follow-up is rejected/deferred |

Set them on `add` / `set` with `--acceptance`, `--files` (comma list), `--kind`, `--origin`, `--resolution`.

## Jira setup

Required env vars (never on disk):
- `PTASKS_JIRA_EMAIL`
- `PTASKS_JIRA_TOKEN`

Generate the API token at https://id.atlassian.com/manage-profile/security/api-tokens.

### Known limitation — optional fields in Jira

The optional work-item fields (`acceptance`, `files`, `kind`, `origin`, `resolution`) have no guaranteed custom field in an arbitrary Jira project, so they are **not** stored in dedicated fields. On write, they are serialised into a clearly-delimited block appended to the issue **description**:

```
----- p-tasks metadata (managed; edit via /p-tasks:set) -----
acceptance: ...
files: a.ts, b.ts
origin: plan
----- end p-tasks metadata -----
```

On read, the block is split off so the human description is recovered cleanly, and the fields are parsed back **best-effort**: a hand-edited or malformed block is ignored rather than rejected. If you edit the description in the Jira UI, keep the block intact (or let `/p-tasks:set` rewrite it) to avoid losing the fields. The FS destination stores the fields natively in `tasks.yml`; only the Jira destination uses this description-block workaround.

## Design

See [`docs/superpowers/specs/2026-05-20-p-tasks-plugin-design.md`](./docs/superpowers/specs/2026-05-20-p-tasks-plugin-design.md) and [`docs/superpowers/plans/2026-05-20-p-tasks-plugin.md`](./docs/superpowers/plans/2026-05-20-p-tasks-plugin.md).

## Validate

```bash
node scripts/validate.mjs                                                  # from repo root
npm test -- plugins/p-tasks                                                # run only p-tasks tests
```
