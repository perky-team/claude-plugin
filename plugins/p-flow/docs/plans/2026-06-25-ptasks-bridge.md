# p-flow ↔ p-tasks soft bridge — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let p-flow optionally mirror a task into the `p-tasks` tracker **only when p-tasks is actually initialised in the same repo**, without coupling the two plugins. Concretely:

- After a plan is approved (`writing-plan`), offer to create one p-tasks `task` named exactly `<slug>`, plus one `sub-task` per `## Steps` item.
- At finalize time (`task-end`), offer to mark that `<slug>` task `done`.

Both points are **offers, never silent actions** — and if p-tasks isn't present they are completely invisible.

**Non-goals (deliberately out of scope):**

- No `dependencies` entry in `plugin.json`. The platform's `dependencies` field is **hard/required** (transitive enable, disable blocked) — using it would force p-tasks to install alongside p-flow and break standalone p-flow. The platform has **no optional-dependency type** (open feature requests anthropics/claude-code#9444, #27113), so optionality must be done at runtime by us.
- No reverse coupling. `p-tasks` is **not touched** and remains unaware of p-flow.
- No direct CLI call into p-tasks. `${CLAUDE_PLUGIN_ROOT}` is per-plugin — p-flow cannot resolve p-tasks' install path. The bridge goes through the **Skill tool** (`p-tasks:add` / `p-tasks:set`), which lets p-tasks resolve its own root.
- No per-step "mark sub-task done during implementation" — p-flow doesn't own the implementation loop (`test-driven-development` does). Deferred (see Open questions).
- No `task-start` integration — keep task opening focused; the task is created once the plan exists. Deferred (see Open questions).

**Architecture:**

```
writing-plan ──(plan approved)──► [gate: docs/tasks/.ptasks.json present?]
                                        │ no  → silent no-op, done
                                        │ yes → offer: create p-tasks task "<slug>" + sub-tasks per Step
task-end ─────(after MR recommend)─► [same gate]
                                        │ yes → offer: set "<slug>" task --status done
```

- **Detection gate:** existence of `<repo-root>/docs/tasks/.ptasks.json` (the config file `p-tasks:init` always writes, for both `fs` and `jira` primaries — see `plugins/p-tasks/skills/init/SKILL.md` Step 1). Absent ⇒ p-tasks not active here ⇒ do nothing, continue normally.
- **Join key:** the p-tasks `task` title is set to **exactly** the p-flow `<slug>`. Slugs are unique per repo (branch/dir names), so later exact-title resolution (`p-tasks:set` Step 1 does title→id lookup) is unambiguous. No id is persisted in p-flow artifacts — keeps `plan.md`/spec schema and their consistency tests untouched.
- **Dispatch:** always via the Skill tool invoking the p-tasks skills (`p-tasks:add` to create, `p-tasks:set` to close, `p-tasks:next --all` to enumerate open sub-tasks). Never `node .../ptasks.mjs`.
- **Confirmation:** every offer is explicit. If `.ptasks.json` shows `primary: jira`, the offer must warn it creates real Jira issues (per repo rule: external/irreversible actions need an explicit yes).
- **Single source of the contract:** one new shared doc `skills/_shared/ptasks-bridge.md` holds the gate + dispatch + join-key rules; both skills reference it instead of duplicating prose.

**Tech stack:** Markdown SKILL edits, `Bash(test:*)` for the gate, `Read` to inspect `.ptasks.json`, the `Skill` tool for dispatch (no `allowed-tools` entry needed — `task-start` already invokes `task-brainstorming` via the Skill tool without listing it). Vitest for the test suite (repo-root `tests/`, `vitest.config.ts`).

**Spec reference:** Conversation 2026-06-25 — agreed: soft/optional integration only, no manifest dependency, bridge via Skill tool gated on `docs/tasks/.ptasks.json`, offers never silent, p-tasks untouched.

---

## File map

| # | Path | Action | Task |
|---|---|---|---|
| 1 | `plugins/p-flow/skills/_shared/ptasks-bridge.md` | **new** — shared bridge contract | 1 |
| 2 | `plugins/p-flow/skills/writing-plan/SKILL.md` | add gate + offer step; add `Bash(git rev-parse:*) Bash(test:*)` to allowed-tools | 2 |
| 3 | `plugins/p-flow/skills/task-end/SKILL.md` | add gate + offer step | 3 |
| 4 | `plugins/p-flow/skills/using-p-flow/SKILL.md` | add one "integrates with p-tasks if present" line | 4 |
| 5 | `plugins/p-flow/README.md` | document the integration | 4 |
| 6 | `plugins/p-flow/CLAUDE.md` | architecture-decision row + What-lives-where note | 4 |
| 7 | `tests/p-flow-ptasks-bridge.test.ts` | **new** — independence + decoupling + gate invariants | 5 |
| 8 | `tests/p-flow-ptasks-recipe.test.ts` | **new** — data-recipe e2e + no-cascade guard (drives real p-tasks CLI) | 5b |
| 9 | `plugins/p-flow/CLAUDE.md` | add both tests to the `## Test invariants` table | 5b |
| 10 | `plugins/p-flow/.claude-plugin/plugin.json` | bump 1.0.0 → 1.1.0 + description | 6 |
| 11 | `plugins/p-flow/RELEASE-NOTES.md` | prepend v1.1.0 section | 6 |

---

## Task 1 — New shared bridge contract

**Files:**
- Create: `plugins/p-flow/skills/_shared/ptasks-bridge.md`

- [ ] **Step 1: Write the file** with this exact content:

````markdown
# p-tasks bridge (shared by writing-plan + task-end)

p-flow optionally mirrors a task into the `p-tasks` tracker — **only** when p-tasks is
initialised in this same repo. This is a one-way, opt-in courtesy: p-flow knows about
p-tasks; p-tasks knows nothing about p-flow.

## Gate — run this BEFORE any p-tasks action

1. Resolve repo root (`git rev-parse --show-toplevel`).
2. `test -f "<root>/docs/tasks/.ptasks.json"`.
   - **Absent** → p-tasks is NOT active in this repo. Do nothing, say nothing, continue
     the host skill normally. (Do not offer, do not mention p-tasks.)
   - **Present** → continue below.

## Dispatch rules

- **Never** call p-tasks' CLI directly. There is no path to p-tasks' own
  `${CLAUDE_PLUGIN_ROOT}` from inside p-flow. Always go through the **Skill tool**,
  invoking the p-tasks skills — `p-tasks:add` (create), `p-tasks:set` (close),
  `p-tasks:next --all` (enumerate open sub-tasks) — and let p-tasks resolve its own install.
- **Join key:** the p-tasks top-level `task` title is set to **exactly** the p-flow
  `<slug>`. That string is the only link — no id is stored in p-flow files. Later lookups
  resolve the task by exact title match (`p-tasks:set` does title→id resolution).
- **No status cascade in p-tasks.** Parent and sub-task statuses are independent. When
  closing a task, close its still-open sub-tasks too — otherwise they dangle open in
  `summary`/`next`. Enumerate the still-open ones with `p-tasks:next --all` filtered to this
  parent (NOT `p-tasks:summary` — `summary` returns only **done** items, so it would list
  nothing to close). Then `p-tasks:set <st-id> --status done` for each.

## Confirmation rules

- Every mirror action is an **offer**, never silent. The user may decline; declining is
  not an error and must not block the host skill.
- `Read` `<root>/docs/tasks/.ptasks.json`. If its `primary` (or mirror) destination is
  `jira`, the offer MUST warn: *"This creates real Jira issues."* — and proceed only on an
  explicit yes (repo rule: external/irreversible actions need explicit confirmation).
````

---

## Task 2 — `writing-plan`: offer to create task + sub-tasks

**Files:**
- Modify: `plugins/p-flow/skills/writing-plan/SKILL.md`

- [ ] **Step 1: Add `Bash(test:*)` to allowed-tools** for the gate. Replace line 4:

  Old: `allowed-tools: Read Write Edit`
  New: `allowed-tools: Read Write Edit Bash(git rev-parse:*) Bash(test:*)`

- [ ] **Step 2: Add procedure step 7** right after the current step 6 ("Show to user").
  Insert below the `## Procedure` list:

````markdown
7. **(optional) Offer to mirror into p-tasks.** Run the gate in
   `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md`. If p-tasks is **not** active, skip
   this step silently. If it **is** active, after the user has approved the plan, offer:

   *"p-tasks is set up in this repo. Want me to create a `<slug>` task there with one
   sub-task per plan step?"* (If the `.ptasks.json` destination is `jira`, add the
   real-Jira-issues warning from the bridge doc.)

   On an explicit **yes**:
   - Via the Skill tool, invoke `p-tasks:add` to create `task` with `--title "<slug>"`
     and an optional `--description` = the first sentence of the spec `## Overview`/
     `## Problem Statement`. Capture the returned parent id (`t-N`).
   - For each item under `## Steps` in `specs/<slug>/plan.md`, via the Skill tool invoke
     `p-tasks:add` to create `sub-task <parent-id>` with `--title "<the step's title>"`.
   - Confirm to the user how many sub-tasks were created.

   On **no** (or decline): continue — the plan is already written and complete. Mirroring
   is never a precondition for finishing `writing-plan`.
````

- [ ] **Step 3: Reference the bridge doc from `## Out of scope`** so the dependency is
  discoverable. Append a bullet under `## Out of scope`:

  `- p-tasks mirroring is opt-in and gated — see ${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md. Never created without an explicit user yes.`

- [ ] **Step 4: Commit.**

```bash
git add plugins/p-flow/skills/writing-plan/SKILL.md plugins/p-flow/skills/_shared/ptasks-bridge.md
git commit -m "feat(p-flow): writing-plan offers to mirror plan steps into p-tasks when present"
```

---

## Task 3 — `task-end`: offer to close the p-tasks task

**Files:**
- Modify: `plugins/p-flow/skills/task-end/SKILL.md`

- [ ] **Step 1: Add a step 11** after step 10 (worktree cleanup reminder), before
  `## What this skill does NOT do`:

````markdown
11. **(optional) Offer to close the p-tasks task.** Run the gate in
    `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md`. If p-tasks is **not** active, skip
    silently. If active **and** a `<slug>` was resolved in pre-check 3, offer:

    *"Mark the `<slug>` task and its sub-tasks done in p-tasks?"* (Add the Jira warning from
    the bridge doc if the destination is `jira`.)

    On an explicit **yes**: via the Skill tool, mark the task whose title is exactly `<slug>`
    `--status done`, **and** mark each of its still-open sub-tasks `--status done` too.
    p-tasks has **no status cascade** (parent and sub-task statuses are independent —
    verified in `plugins/p-tasks/tools/lib/next.mjs` / `schema.mjs`), so closing only the
    parent would leave its sub-tasks dangling `todo`/`in_progress` in `summary`/`next`.
    Enumerate the still-open sub-tasks with `p-tasks:next --all` filtered to this parent —
    **not** `p-tasks:summary`, which returns only **done** items and would list nothing to
    close (verified in `plugins/p-tasks/tools/lib/summary.mjs`) — then `p-tasks:set <st-id>
    --status done` for each. (`next --all` excludes a sub-task only if it is itself blocked
    by an unfinished item; at task-end, with work complete, that is normally moot.)

    On **no**, or if no `<slug>` was resolved: skip. This step never blocks the push or
    the MR recommendation — those have already happened.
````

- [ ] **Step 2: Add a bullet to `## What this skill does NOT do`:**

  `- Does not create or mutate p-tasks items silently — only offers (gated on p-tasks being present), and only with an explicit user yes. See _shared/ptasks-bridge.md.`

- [ ] **Step 3: Commit.**

```bash
git add plugins/p-flow/skills/task-end/SKILL.md
git commit -m "feat(p-flow): task-end offers to close the matching p-tasks task when present"
```

---

## Task 4 — Discovery + docs

**Files:**
- Modify: `plugins/p-flow/skills/using-p-flow/SKILL.md`
- Modify: `plugins/p-flow/README.md`
- Modify: `plugins/p-flow/CLAUDE.md`

- [ ] **Step 1: Add a line to `using-p-flow/SKILL.md` `## Hard rules`:**

  `- **p-tasks is optional.** If (and only if) p-tasks is initialised in the repo (\`docs/tasks/.ptasks.json\` exists), \`writing-plan\` and \`task-end\` offer to mirror/close a task there. Never automatic, never silent, and absent entirely when p-tasks isn't installed.`

- [ ] **Step 2: Add a `## Integration` section to `README.md`** (after `## Reviewer templates`):

````markdown
## Integration with p-tasks (optional)

If the [`p-tasks`](../p-tasks/) tracker is initialised in the same repo (detected by
`docs/tasks/.ptasks.json`), p-flow offers two opt-in mirror points:

| Skill | Offer |
|---|---|
| `writing-plan` | After the plan is approved — create a p-tasks `task` named `<slug>` plus one `sub-task` per `## Steps` item. |
| `task-end` | After the MR recommendation — mark the `<slug>` task **and its sub-tasks** `done` (p-tasks has no status cascade, so both are closed explicitly). |

This is a **soft, one-way** integration: p-flow knows about p-tasks, not the reverse, and
there is **no plugin-manifest dependency** — each plugin installs and runs standalone.
When p-tasks is absent, these offers never appear. The bridge dispatches through the
Skill tool (`p-tasks:add` / `p-tasks:set`), never p-tasks' CLI, so it respects per-plugin
isolation. Every action is an explicit offer (and warns before creating real Jira issues).
Contract: `skills/_shared/ptasks-bridge.md`.
````

- [ ] **Step 3: Add an architecture-decision row to `CLAUDE.md`** (the `| Decision | Wave | Doc |` table):

```markdown
| Optional soft bridge to `p-tasks`: gated on `docs/tasks/.ptasks.json`, dispatched via the Skill tool (`p-tasks:add`/`p-tasks:set`) NOT its CLI, join-key = task title == `<slug>`, offers never silent. NO `plugin.json#dependencies` (platform deps are hard/required; would break standalone p-flow). p-tasks untouched. | F | `docs/plans/2026-06-25-ptasks-bridge.md` |
```

- [ ] **Step 4: Add to `CLAUDE.md` `## What lives where`** under the `skills/_shared/` line:

  `│   │   └── ptasks-bridge.md   ← shared p-tasks integration contract (gate + dispatch + join-key)`

- [ ] **Step 5: Commit.**

```bash
git add plugins/p-flow/skills/using-p-flow/SKILL.md plugins/p-flow/README.md plugins/p-flow/CLAUDE.md
git commit -m "docs(p-flow): document optional p-tasks bridge (README, CLAUDE.md, using-p-flow)"
```

---

## Task 5 — Invariant test

**Files:**
- Create: `tests/p-flow-ptasks-bridge.test.ts`

This test defends the three invariants that make the integration safe and keep the
plugins independently usable: **independence** (no manifest dependency), **decoupling**
(no cross-plugin CLI call), and **gating** (the bridge is always behind the marker check).

- [ ] **Step 1: Read an existing p-flow test** (e.g. `tests/p-flow-cross-skill-consistency.test.ts`)
  to copy the import style, path resolution helper, and `describe/it` conventions exactly.
  Do not invent a new harness.

- [ ] **Step 2: Write `tests/p-flow-ptasks-bridge.test.ts`** asserting:

  1. **Independence (the standalone guarantee)** — `plugins/p-flow/.claude-plugin/plugin.json`
     parsed as JSON has **no** `dependencies` key (and no `requires`/`extends`). This
     mechanically prevents a future edit from coupling p-flow to p-tasks at the manifest
     level — the platform's `dependencies` field is hard/required and would force p-tasks
     to install alongside p-flow, breaking standalone use.
  2. **Bridge doc exists** at `plugins/p-flow/skills/_shared/ptasks-bridge.md` and contains
     all of: the marker path `docs/tasks/.ptasks.json`, the string `Skill tool`,
     `p-tasks:add`, `p-tasks:set`, `p-tasks:next` (the enumeration command — guards against a
     revert to the wrong `summary`-based enumeration), and the "absent → silent no-op" rule
     (assert it contains both `Absent` and `silent`, proving p-flow stays inert when p-tasks
     isn't present).
  3. **Both host skills reference the bridge doc** — `writing-plan/SKILL.md` and
     `task-end/SKILL.md` each contain `_shared/ptasks-bridge.md`.
  4. **No cross-plugin CLI coupling** — NO p-flow skill file (`skills/**/SKILL.md` and the
     bridge doc) contains the literal `ptasks.mjs`. This is the decoupling guarantee.
  5. **Gate is present** — each host skill body references `_shared/ptasks-bridge.md` (the
     reference from assertion 3); assert it explicitly so a future edit that drops the gate
     fails the test.

- [ ] **Step 3: Run the new test in isolation**, confirm green:

```bash
npx vitest run tests/p-flow-ptasks-bridge.test.ts
```

- [ ] **Step 4: Commit.**

```bash
git add tests/p-flow-ptasks-bridge.test.ts
git commit -m "test(p-flow): guard p-tasks bridge decoupling + gate invariants"
```

---

## Task 5b — Data-recipe + no-cascade test

**Files:**
- Create: `tests/p-flow-ptasks-recipe.test.ts`

Static tests (Task 5) prove the *prose* is right; this test proves the *recipe the prose
prescribes* actually produces a correct p-tasks store, and pins the one external assumption
`task-end` depends on: **p-tasks has no status cascade**. It drives the **real** p-tasks CLI
as a black box through its public commands — exactly as the bridge does at runtime through
the Skill tool — so it does NOT import p-tasks internals (no deeper coupling than the runtime
already has).

> **Cross-plugin note (tests only):** this is a p-flow test that spawns p-tasks' CLI
> (`plugins/p-tasks/tools/ptasks.mjs`). The coupling is confined to the test layer — runtime
> stays fully decoupled (Task 5 still forbids `ptasks.mjs` in any p-flow *skill*). The repo
> runs all tests together from the root, so the CLI is present. If p-tasks' CLI entry path or
> flag names change, this test breaks loudly — that's the intended early-warning.

- [ ] **Step 1: Read `plugins/p-tasks/tools/__tests__/cli-e2e.test.ts`** to copy exactly how
  p-tasks tests spawn the CLI and set up a throwaway repo root (temp dir, `--json` parsing,
  exit-code handling). Mirror those conventions; do not invent a new harness. Confirm the CLI
  entry is `plugins/p-tasks/tools/ptasks.mjs` and the fs store path is `docs/tasks/tasks.yml`.

- [ ] **Step 2: Write `tests/p-flow-ptasks-recipe.test.ts`.** In a fresh temp dir per test,
  drive the CLI with `node` (black-box, `--json`) through the exact bridge sequence:

  1. **Setup** — `ptasks.mjs init --primary fs --json` in the temp root. Assert
     `docs/tasks/.ptasks.json` now exists (this is the very marker the bridge gate keys on —
     so the test also documents that the gate's marker is real and CLI-produced).

  2. **`writing-plan` recipe** — emulate a 3-step plan for slug `demo-feature`:
     - `add task --title "demo-feature" --json` → capture parent id `t-1`.
     - `add sub-task t-1 --title "Step 1: ..." --json`, likewise Steps 2 and 3 → `st-1..st-3`.
     - Read `tasks.yml`; assert: one task titled exactly `demo-feature`, three sub-tasks under
       it, all `status: todo`. **Title == slug** is the join key — assert the title string is
       byte-for-byte the slug.

  3. **No-cascade guard (the load-bearing assertion)** — `set t-1 --status done --json`, then
     read `tasks.yml` and assert the parent is `done` **but all three sub-tasks are still
     `todo`**. This pins the fact that closing a parent does NOT cascade. If a future p-tasks
     version adds cascade, this assertion fails — forcing a deliberate review of whether
     `task-end`'s "close sub-tasks explicitly" step is still needed.

  4. **Enumeration-command guard (defends the corrected bridge prose)** — at this point the
     parent is `done` and the three sub-tasks are `todo`. Assert that `summary t-1 --json`
     returns **zero** sub-tasks (summary lists only `done` children — so it is the WRONG
     command to find open sub-tasks), while `next --all --json` **does** return the three
     open sub-tasks (filter its items to `parentId === t-1`). This is exactly why the bridge
     uses `next --all`, not `summary`, to enumerate what to close — the assertion fails if
     anyone reverts the prose to `summary`.

  5. **`task-end` recipe** — close each open sub-task surfaced by `next --all`:
     `set st-1 --status done`, `st-2`, `st-3`. Read `tasks.yml`; assert parent and all three
     sub-tasks are `done` — the fully-closed end state the bridge promises.

  6. **Title-resolution sanity** — now that the task is `done`, call `summary --json` and
     assert exactly one top-level item whose title equals `demo-feature` (summary returns
     done tasks), confirming the slug→task title link is unambiguous.

- [ ] **Step 3: Run the new test in isolation**, confirm green:

```bash
npx vitest run tests/p-flow-ptasks-recipe.test.ts
```

- [ ] **Step 4: Register both new tests in `CLAUDE.md` `## Test invariants` table.** Add two rows:

```markdown
| `tests/p-flow-ptasks-bridge.test.ts` | p-tasks bridge stays decoupled (no `plugin.json#dependencies`, no `ptasks.mjs` in any skill) and gated (host skills reference `_shared/ptasks-bridge.md`; bridge doc keeps the "absent → silent no-op" rule) |
| `tests/p-flow-ptasks-recipe.test.ts` | executable spec: the bridge recipe (create task=`<slug>` + sub-tasks per step → close all) yields a correct p-tasks store; pins the no-status-cascade assumption `task-end` relies on (re-implementation via the real p-tasks CLI — update if the bridge recipe changes) |
```

- [ ] **Step 5: Commit.**

```bash
git add tests/p-flow-ptasks-recipe.test.ts plugins/p-flow/CLAUDE.md
git commit -m "test(p-flow): p-tasks bridge recipe e2e + no-cascade guard"
```

---

## Task 6 — Version bump + release notes + full suite

**Files:**
- Modify: `plugins/p-flow/.claude-plugin/plugin.json`
- Modify: `plugins/p-flow/RELEASE-NOTES.md`
- Run: full suite

- [ ] **Step 1: Bump version 1.0.0 → 1.1.0** (minor — additive, backwards-compatible).
  In `plugin.json`, set `"version": "1.1.0"` and extend the description with one clause:
  `... Optional one-way bridge to p-tasks when present (writing-plan + task-end offer to mirror/close a task). ...`

- [ ] **Step 2: Prepend a release-notes section** above the current top entry
  (`## v5.0.0 ...`):

````markdown
## v?.?.? — `plugins/p-flow 1.1.0` — 2026-06-25 — optional p-tasks bridge

- p-flow now offers a **soft, opt-in** bridge to the `p-tasks` tracker, active **only** when
  p-tasks is initialised in the same repo (detected by `docs/tasks/.ptasks.json`).
  - `writing-plan` — after the plan is approved, offers to create a p-tasks `task` named
    `<slug>` plus one `sub-task` per `## Steps` item.
  - `task-end` — after the MR recommendation, offers to mark the `<slug>` task **and its
    sub-tasks** `done` (p-tasks has no status cascade, so both are closed explicitly).
- **No coupling.** No `plugin.json#dependencies` (the platform's dependency field is
  hard/required and would break standalone p-flow); the bridge dispatches through the Skill
  tool (`p-tasks:add` / `p-tasks:set`), never p-tasks' CLI, so per-plugin isolation holds.
  `p-tasks` is untouched and unaware of p-flow. Both plugins still install/run standalone.
- Every mirror action is an explicit offer — never silent — and warns before creating real
  Jira issues when the p-tasks destination is `jira`.
- Contract centralised in `skills/_shared/ptasks-bridge.md`. Two new tests:
  `tests/p-flow-ptasks-bridge.test.ts` guards independence (no `plugin.json#dependencies`),
  decoupling (no `ptasks.mjs` in any skill), and the gate; `tests/p-flow-ptasks-recipe.test.ts`
  is an executable spec that drives the real p-tasks CLI through the bridge recipe and pins
  the no-status-cascade assumption. Behaviour (does the model fire/gate/confirm correctly) is
  covered by a manual smoke-test checklist in `docs/plans/2026-06-25-ptasks-bridge.md`.

> Marketplace tag assigned at push time per the repo's release rules in `.claude/CLAUDE.md`.
````

- [ ] **Step 3: Run the full suite** — `npm test`. Expected: all green. Skills affected:
  - `tests/skills.test.ts` — `writing-plan` frontmatter still valid (added allowed-tools entries parse fine).
  - `tests/plugin-readme-coverage.test.ts` — no new *skill* added (bridge is a `_shared` doc, not a skill), so coverage is unaffected.
  - `tests/templates.test.ts` — only governs `_shared/templates/`; the new `_shared/ptasks-bridge.md` is outside that dir, so no dead-template failure.
  - `tests/p-flow-ptasks-bridge.test.ts` — new, green.
  - `tests/p-flow-ptasks-recipe.test.ts` — new, green (spawns the real p-tasks CLI; needs Node 18+, which the repo already requires).

- [ ] **Step 4: If anything fails**, fix the SKILL/doc (never the test invariant), re-run.

- [ ] **Step 5: Commit.**

```bash
git add plugins/p-flow/.claude-plugin/plugin.json plugins/p-flow/RELEASE-NOTES.md
git commit -m "chore(release): p-flow 1.1.0 — optional p-tasks bridge"
```

---

## Self-review

1. **Independence + decoupling preserved** — no `dependencies` in `plugin.json` (Task 6 Step 1
   only bumps version + description; Task 5 assertion 1 forbids the key outright); dispatch is
   Skill-tool only (Tasks 1–3); Task 5 assertion 4 mechanically forbids `ptasks.mjs` in any
   p-flow skill. Standalone p-flow: gate in Task 1 returns "absent" → silent no-op (Task 5
   assertion 2 pins that rule). Standalone p-tasks: untouched (no p-tasks file in the file
   map). Both verified by construction and by test.
2. **Gating** — every p-tasks action in Tasks 2 and 3 begins with the Task 1 gate; Task 5
   assertion 5 defends it.
3. **Confirmation** — every offer is explicit prose; Jira warning specified in the bridge
   doc and echoed in both skills. Satisfies the repo's external-action rule.
4. **Naming/consistency** — marker path `docs/tasks/.ptasks.json` identical across bridge
   doc, both skills, README, CLAUDE.md row, release notes, and test. Join key (`title == <slug>`)
   stated once in the bridge doc and relied on (not re-specified) elsewhere. Version `1.1.0`
   agrees across `plugin.json`, release-notes header, and commit message.
5. **No canonical-section drift** — nothing renames/reorders `plan.md` sections; the bridge
   only *reads* `## Steps` and `## Overview`. `tests/p-flow-cross-skill-consistency.test.ts`
   unaffected.

## Manual smoke test (behavioural layer — not automatable)

Whether the model actually *fires* the bridge at the right moment, gates correctly, and never
acts silently is prompt-discipline — the same class the README already flags as "manual
smoke-test only, no automated way to assert." Run this checklist by hand whenever the bridge
doc or either host skill changes (mirrors the reviewer-template smoke test in
`docs/plans/2026-05-27-task-flow-followups.md`). Use Sonnet+ (weaker models skip gates).

Set up two throwaway repos and walk a task through `writing-plan` → `task-end` in each:

- [ ] **p-tasks absent** (no `docs/tasks/.ptasks.json`): the bridge is fully invisible —
      `writing-plan` and `task-end` finish normally and **never mention p-tasks**. (This is
      the standalone-p-flow guarantee, observed end-to-end.)
- [ ] **p-tasks present, primary `fs`**: `writing-plan` *offers* (does not auto-run) to create
      the `<slug>` task + one sub-task per `## Steps`; on yes, `tasks.yml` matches. Declining
      leaves the plan complete and writes nothing.
- [ ] **p-tasks present, primary `jira`**: the offer **explicitly warns** it creates real Jira
      issues and proceeds only on an explicit yes.
- [ ] **task-end close**: offers to close the `<slug>` task **and** its sub-tasks; on yes, all
      are `done` (no dangling open sub-task). Declining skips without blocking push/MR.
- [ ] **slug not resolvable** (branch off-convention): `task-end` skips the p-tasks offer with
      no error, exactly as it already skips its plan/marker pre-checks.

Record the run (date, model, pass/fail per row) in the MR description — there is no green bar
for this layer, so the smoke test IS the evidence.

## Resolved decisions

All previously-open forks are now closed — no decisions are deferred to execution time.

1. **Where the task is created → `writing-plan`, not `task-start`. (Closed: No to task-start.)**
   `task-start` ends by handing off to `task-brainstorming`, so an offer there would interrupt
   the flow, and a task with no plan is just a bare title. Creating the `task` + per-step
   `sub-task`s once the plan exists is where the data is meaningful. `task-start` gets **no**
   p-tasks touch.

2. **Per-step progress during implementation → not done. (Closed: No.)** Marking each
   `sub-task` `done` as coding proceeds would need a hook inside the implementation loop, which
   `test-driven-development` owns, not p-flow. The granularity is fixed: create at
   `writing-plan`, close at `task-end`. Not revisited.

3. **Cascade on close → close parent AND sub-tasks. (Closed, fact-based.)** p-tasks has **no**
   status cascade — parent and sub-task statuses are independent (verified in
   `plugins/p-tasks/tools/lib/next.mjs` and `schema.mjs`). Closing only the parent would leave
   its sub-tasks dangling `todo`/`in_progress` in `summary`/`next`. So `task-end` (Task 3)
   explicitly offers to close the parent and each still-open sub-task. Whether p-tasks ever
   grows native cascade is p-tasks' concern; p-flow does the right thing regardless.

4. **Rule-template mention → no. (Closed: No.)** `/p-flow:init`'s `rules-p-flow.template.md`
   is **not** changed. The bridge is self-announcing via the two offers, and discovery is
   already surfaced by the `using-p-flow` `## Hard rules` line (Task 4 Step 1). Keeping the
   change contained to skills avoids editing what `/p-flow:init` writes into user repos.

**Independence (the standing requirement).** Both plugins remain usable on their own, by
design and by test: no `plugin.json#dependencies` (Task 5 assertion 1 forbids the key), the
bridge is gated on `docs/tasks/.ptasks.json` so p-flow is inert without p-tasks (Task 5
assertion 2 pins the "absent → silent no-op" rule), and dispatch is via the Skill tool, never
p-tasks' CLI (Task 5 assertion 4). p-tasks is never edited and stays unaware of p-flow.

## Risks

- **Title-collision on the join key.** Resolution by exact title `<slug>` is safe because
  slugs are unique per repo (branch/dir names). Risk only if a user manually creates a
  p-tasks task whose title duplicates a slug. Mitigation: `p-tasks:set` Step 1 already asks
  when title resolution is ambiguous — acceptable. Documented here, not engineered around.
- **Model skips the gate.** The bridge is prose the model must honour. If the model offers
  p-tasks actions when `.ptasks.json` is absent, that's a discipline failure, not a crash
  (p-tasks skills simply won't exist to invoke). Test assertion 4 keeps the gate text in
  place; behaviour is best-effort like all skill prose.
- **`.ptasks.json` in a non-standard location.** `p-tasks:init` always scaffolds under
  `docs/tasks/`. If a future p-tasks version makes the location configurable, the hardcoded
  marker path drifts. Mitigation: single source in the bridge doc — one edit fixes all
  call sites. Flag noted for whoever bumps p-tasks.
