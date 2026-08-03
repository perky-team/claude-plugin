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

## Dependency shipping

Plugins are distributed by **copying files into a cache** — there is no `npm install` at install time, so the CLI must run with nothing but the files in this directory. A bare `import 'js-yaml'` only resolves while a `node_modules` tree happens to sit above `tools/` in the dev checkout; once the plugin is copied into the cache alone it dies with `ERR_MODULE_NOT_FOUND` (this is exactly what regressed in 1.1.0).

So the **single runtime dependency (`js-yaml`) is vendored**, not declared: its self-contained ESM build is committed at [`tools/lib/vendor/js-yaml.mjs`](./tools/lib/vendor/js-yaml.mjs) and imported by relative path from `tools/lib/yaml.mjs`. The root `.gitignore` excludes `node_modules/` but **not** `tools/lib/vendor/`, so the file ships. (Same approach as p-graph's `tools/vendor/`.)

Rules for future changes:
- **Never add a bare runtime `import`** to anything under `tools/` (test/dev-only deps like `vitest` are fine — they never ship). Vendor it instead.
- To add or update a vendored dependency, bump it in the **root** `package.json`, run `node plugins/p-tasks/scripts/vendor-deps.mjs`, and commit the refreshed `tools/lib/vendor/` file.
- `tests/p-tasks-packaging.test.ts` (in the root suite, run by `npm test` / the `/release` audit) enforces this: it fails on any bare runtime import and runs the CLI from an isolated copy with no `node_modules` above it.

## HTTP transport — never the global `fetch`

`makeTransport()` in `tools/lib/destination.mjs` uses `node:https` with a per-request
agent set to `keepAlive: false`. Do not replace it with `fetch`.

The CLI calls `process.exit()` right after a command finishes. `fetch` is undici, which
keeps a socket pool alive past the response, and exiting into that teardown aborts the
process on Windows with a libuv assertion (`!(handle->flags & UV_HANDLE_CLOSING)`,
`src\win\async.c`) and exit code 3221226505 — after the work is done and the output is
already correct. Two Jira calls in one run are enough. The CLI tests inject a fake
transport, so they never see it.

If `fetch` is ever needed, drop `process.exit()` first: set `process.exitCode` and
return, as `p-chat` does. `tests/cli-exit-safety.test.ts` enforces one of the two.

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

## `ptasks guard` — a p-shed guard over the backlog

Not a skill: a CLI command meant for the `guard:` field of a [p-shed](../p-shed/) job, in
front of an expensive `claude -p` launch.

| exit | meaning |
|---|---|
| `0` | there is actionable work — launch |
| `75` | deliberately quiet, no work this slot (not a failure, no history row) |
| other | guard error, counted toward the job's circuit breaker |

It answers with `pickNext` — the same code path as `/p-tasks:next`, so the guard and
`next` can never disagree about what counts as actionable.

```bash
ptasks guard                                   # ready: st-206 (2 actionable of 7 open)   → 0
ptasks guard --exclude-origin human:           # no work: 3 open, 3 excluded by origin    → 75
ptasks guard --json                            # same exit codes, JSON envelope on stdout
```

`--exclude-origin <prefix>` (repeatable) skips items whose `origin` starts with the
prefix. The case it exists for: `origin: human:<something>` marks an item parked on a
person — a question the loop asked and cannot answer itself. Such items are legitimately
open and `pickNext` legitimately returns them, but a worker launched for one can only
re-read the question and stop. Excluded items still count as blockers for other items.

The single stdout line is the reason p-shed records as `lastGuard.reason` and prints in
`pshed status`, so it is what an operator reads when asking "why did the worker not run?".

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

Design specs and implementation plans for this plugin live under [`docs/`](./docs/).

## Validate

```bash
node scripts/validate.mjs                                                  # from repo root
npm test -- plugins/p-tasks                                                # run only p-tasks tests
```
