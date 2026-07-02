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

## Status lifecycle (canonical mode)

p-tasks statuses are three-state — `todo | in_progress | done` — and p-flow drives **all
three**. This section is the canonical reference; `executing-plan`,
`subagent-driven-development`, and `receiving-code-review` point here rather than
re-describing it.

**The ledger has three meaningful states:**

| Status | Meaning | On resume |
|---|---|---|
| `todo` | **not started** — genuinely untouched | safe to start fresh |
| `in_progress` | work **began** but is not verified-complete | it was **INTERRUPTED** mid-step — reconcile; do **not** treat it as done and do **not** blindly re-run it from scratch |
| `done` | acceptance criterion met **and** verified green | complete — never re-dispatch |

**Transitions — who sets what, and when:**

- **Sub-task → `in_progress` the moment work on it BEGINS**, via the Skill tool
  `p-tasks:set <st-id> --status in_progress`:
  - `executing-plan` — right **before implementing** the step.
  - `subagent-driven-development` — right **before dispatching** the implementer subagent
    for that step.
  - `receiving-code-review` — when it **starts working** a review follow-up sub-task
    (before verifying the finding).
- **Parent task → `in_progress` when the FIRST sub-task starts**, if the parent is still
  `todo`: `p-tasks:set <parent> --status in_progress`. There is no cascade (see above), so
  set it explicitly, once, on the first step.
- **Sub-task → `done` ONLY when the acceptance criterion is met and verified green** —
  `p-tasks:set <st-id> --status done`. For a reviewed step, only after its per-step review
  passes; for a review follow-up, on resolution (add `--resolution "rejected|deferred:
  <reason>"` for a reject/defer, as today). `task-end` still closes the parent and any
  remaining sub-tasks at the end (unchanged — no cascade means it must close each).

**Interrupt / resume (the important part).** On resume, read `p-tasks:list <parent>`
**first**. A sub-task left `in_progress` was **INTERRUPTED**, not finished. Do **not** treat
it as done, and do **not** blindly re-run it from scratch. **Reconcile first:** inspect git
(`git log`, working tree) and any step artifacts for partial work, verify what exists
against the sub-task's acceptance criterion, then either finish/verify it or redo it
cleanly — and only then set `--status done`. A `todo` sub-task is genuinely untouched; a
`done` one is verified-complete and must not be re-dispatched. Trust this ledger over your
own recollection after compaction — it now carries three meaningful states, not two.

**Legacy plan.md is binary — unchanged.** The legacy `- [ ]` / `- [x]` checkboxes are
two-state and **cannot express "in progress"**: an interrupted legacy step is
indistinguishable from a never-started one. Legacy behaviour stays byte-for-byte the same
(checkboxes remain binary, no `in_progress`); this three-state lifecycle applies to
**canonical mode only**. That gap — no interrupt signal — is a concrete reason the
canonical/p-tasks flow is preferable to legacy plan.md.

## Confirmation rules

- `Read` `<root>/docs/tasks/.ptasks.json`. If its `primary` (or a mirror) destination is
  **`jira`**, any action that creates or updates issues MUST warn first:
  *"This creates/updates real Jira issues."* — and proceed only on an explicit yes
  (repo rule: external/irreversible actions need explicit confirmation).
- For an **`fs`** primary the canonical store is a local, reversible file (`tasks.yml`).
  Driving it is part of the normal flow — no separate offer prompt is needed (it replaces the
  `## Steps` edits the legacy flow would have made anyway).
