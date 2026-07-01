# p-tasks bridge (shared by writing-plan, executing-plan, review skills, task-end)

When `p-tasks` is initialised in this same repo, it is the **single canonical store** for
the task/step list and statuses. p-flow drives it; there is **no `plan.md`** in this mode —
the narrative lives in `specs/<slug>/specification.md` instead. This is still one-way: p-flow
knows about p-tasks; p-tasks knows nothing about p-flow.

## Gate — run this BEFORE any p-tasks action

1. Resolve repo root (`git rev-parse --show-toplevel`).
2. `test -f "<root>/docs/tasks/.ptasks.json"`.
   - **Absent** → p-tasks is NOT active in this repo. Behave **exactly** as the legacy
     plan.md-only flow: the step list lives as a `## Steps` checklist in
     `specs/<slug>/plan.md`, checked off in place. Do nothing p-tasks-related, say nothing
     (silent no-op). This path must be byte-for-byte unchanged from before the bridge existed.
   - **Present** → p-tasks is the canonical work-item store. Follow the canonical rules below.

## What lives where (when p-tasks is active)

When p-tasks is active there is **no `plan.md`** at all. p-tasks is the single artifact for the
step list, the review follow-ups, and the review audit; the task **narrative** lives in
`specs/<slug>/specification.md` (plus a concise Overview in the parent task's `--description`).

- **p-tasks owns WORK ITEMS.** Plan steps and review follow-ups are each a `sub-task` under a
  parent `task` titled **exactly** the `<slug>`, each with a status. The step list and its
  statuses live **only** in `tasks.yml` (or Jira) — never duplicated in a `plan.md`.
- **The review audit lives in p-tasks too.** A deferred or rejected finding is a `sub-task`
  carrying `--origin <code-review|task-review>:<severity> --status done --resolution
  "deferred: <reason>"` / `"rejected: <reason>"`. The `resolution` field **is** the audit trail —
  there is no `## Review decisions (audit)` section and no `plan.md` to hold one.
- **Narrative lives in `specification.md`.** Overview / Risks / Open questions were authored by
  `task-brainstorming` in `specs/<slug>/specification.md`; p-flow does **not** duplicate them into
  a `plan.md`. Nothing in the canonical flow creates or requires `specs/<slug>/plan.md`.

## Dispatch rules

- **Never** call p-tasks' CLI directly. There is no path to p-tasks' own
  `${CLAUDE_PLUGIN_ROOT}` from inside p-flow. Always go through the **Skill tool**, invoking
  the p-tasks skills — `p-tasks:add` (create), `p-tasks:set` (update/close),
  `p-tasks:list` (walk the whole plan), `p-tasks:summary` (done items), `p-tasks:next`
  (next open item) — and let p-tasks resolve its own install.
- **Join key:** the p-tasks top-level `task` title is set to **exactly** the p-flow `<slug>`.
  That string is the only link — no id is stored in p-flow files. Later lookups resolve the
  task by exact title match (`p-tasks:set` does title→id resolution).

## Work-item fields (p-tasks ≥ 1.1)

Each sub-task may carry these optional fields; set them with flags on `add`/`set`:

| Field | Flag | Meaning |
|---|---|---|
| `acceptance` | `--acceptance` | the step's acceptance criterion |
| `files` | `--files` (comma list) | expected affected files |
| `kind` | `--kind code\|non-code` | execution classification (absent → treat as `code`) |
| `origin` | `--origin` | `plan` (default) \| `code-review:<severity>` \| `task-review:<severity>` |
| `resolution` | `--resolution` | evidence-based reason recorded when a follow-up is rejected/deferred |

## Walk the plan

- `p-tasks:list <parent>` returns the parent's sub-tasks in **document order**, each with its
  `status` and the fields above — the canonical walk for `executing-plan` and the
  completeness count for `task-end`. Use `list`, **not** `summary` (done only) or `next`
  (open only), when you need to see the whole plan regardless of state.

## No status cascade in p-tasks

Parent and sub-task statuses are independent. Closing a `task` does **not** close its
sub-tasks. When finishing, enumerate the still-open sub-tasks with `p-tasks:list <parent>`
and close each explicitly with `p-tasks:set <st-id> --status done` — otherwise they dangle
open in `list`/`next`.

## Confirmation rules

- `Read` `<root>/docs/tasks/.ptasks.json`. If its `primary` (or a mirror) destination is
  **`jira`**, any action that creates or updates issues MUST warn first:
  *"This creates/updates real Jira issues."* — and proceed only on an explicit yes
  (repo rule: external/irreversible actions need explicit confirmation).
- For an **`fs`** primary the canonical store is a local, reversible file (`tasks.yml`).
  Driving it is part of the normal flow — no separate offer prompt is needed (it replaces the
  `## Steps` edits the legacy flow would have made anyway).
