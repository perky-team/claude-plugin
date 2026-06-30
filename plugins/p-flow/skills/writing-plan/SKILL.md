---
name: writing-plan
description: Use after a spec exists at `specs/<slug>/specification.md` to produce a step-by-step implementation plan at `specs/<slug>/plan.md`. Refuses to write a step without an acceptance criterion. Decomposes work into 5–15 steps; flags larger work for sub-task split.
allowed-tools: Read Write Edit Bash(git rev-parse:*) Bash(test:*)
---

# writing-plan

Turn the brainstorm artifact into a concrete, ordered plan. One file: `specs/<slug>/plan.md`.

**Announce at start:** *"I'm using the `writing-plan` skill to turn the spec into an implementation plan."*

## Inputs

- `specs/<slug>/specification.md` — required. If missing, stop and tell the user to run `task-brainstorming` first.
- `specs/<slug>/feature.feature` — optional, read if present.
- `specs/<slug>/adr.md` — optional, read if present.

## Procedure

1. **Read the spec(s)** in full.

1a. **Run the p-tasks gate** in `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md`. This decides where the step list will live:
   - **p-tasks absent** → *legacy mode*: the step list is a `## Steps` checklist written into `specs/<slug>/plan.md` (steps 3–8 below, "legacy mode" branch). Behave exactly as before — say nothing about p-tasks.
   - **p-tasks present** → *canonical mode*: p-tasks is the single source of truth for the step list. You will create the parent task + one sub-task per step there, and write a **slim** plan.md with NO `## Steps`. Follow the "canonical mode" branch in steps 3–8.

2. **Detect plan type and ask the user.** Examine the spec to suggest a variant:
   - If `specs/<slug>/feature.feature` exists OR `specification.md` Acceptance Criteria mention function / endpoint / class / handler / script behaviours → suggest **TDD plan** (template: `${CLAUDE_SKILL_DIR}/../_shared/templates/plan-tdd.template.md`).
   - Otherwise → suggest **generic plan** (template: `${CLAUDE_SKILL_DIR}/../_shared/templates/plan-generic.template.md`).

   Ask the user (in prose, no AskUserQuestion):
   *"Based on the spec, I'd suggest a **<TDD|generic>** plan. Confirm, or override with the other variant?"*

   Wait for explicit answer before proceeding. In **canonical mode** the variant also sets the default `kind` per step: a TDD plan's steps are `kind: code` (they describe function/endpoint/class behaviour); a generic plan's steps are `kind: non-code` (docs/config/research). Override per step where a TDD plan contains a docs-only step or vice versa.
3. **Decompose into 5–15 steps.** If you find yourself with more than 15, stop and tell the user the work is too large for one plan — suggest splitting into sub-tasks, each via its own `/p-flow:task-start`. (In canonical mode the count is the number of sub-tasks you will create; the 5–15 guard still applies.)

   **(optional) Consult p-graph for impact.** Run the gate in `${CLAUDE_SKILL_DIR}/../_shared/pgraph-bridge.md`. If a code graph is **not** active, decompose normally — say nothing. If it **is** active and the spec touches existing code, use the graph (per the repo's `.claude/rules/p-graph.md`) to find the impact set: let downstream callers inform step granularity, and record notable affected modules under `## Risks`. Best-effort only — never a precondition.
4. **Every step must have an acceptance criterion.** Concrete and checkable: "tests `X.py::test_foo` and `X.py::test_bar` pass", "endpoint `GET /foo` returns 200 with body matching schema Y", "file `bar.ts` exports the function `baz`". Refuse to write a step without one — ask the user for a criterion instead. For TDD plans, each step also captures the `Test first` / `Implement` / `Verify` shape (in legacy mode as sub-bullets; in canonical mode folded into the sub-task's `acceptance`).

5. **Materialise the steps.**

   **Legacy mode (p-tasks absent):** Read the chosen template (`plan-tdd.template.md` or `plan-generic.template.md`), substitute `{{SLUG}}`, and write the full plan — including the `## Steps` checklist — to `specs/<slug>/plan.md`.

   **Canonical mode (p-tasks present):** The steps live in p-tasks, not plan.md.
   - If the `.ptasks.json` destination is `jira`, first warn per the bridge doc (*"This creates real Jira issues."*) and proceed only on an explicit yes. For an `fs` destination, proceed as part of the normal flow (local, reversible — no separate prompt).
   - Via the Skill tool, invoke `p-tasks:add` to create the parent `task` with `--title "<slug>"` and `--description` = the first sentence of the spec `## Overview` / `## Problem Statement`. Capture the returned parent id (`t-N`).
   - For each step, via the Skill tool invoke `p-tasks:add` to create `sub-task <parent-id>` with `--title "<step title>"`, `--acceptance "<the step's acceptance criterion>"`, `--files "<comma list of expected files>"`, `--kind <code|non-code>` (per step 2), and `--origin plan`.
   - Then write a **slim** plan.md: read `${CLAUDE_SKILL_DIR}/../_shared/templates/plan-tasks.template.md`, substitute `{{SLUG}}`, and write it to `specs/<slug>/plan.md`. It contains an Overview pointer, `## Open questions`, and `## Risks` — and **no `## Steps`** (the step list is in p-tasks).

6. **Self-review:** scan for placeholders (`TBD`, `TODO`, leftover `<...>` markers, internal contradictions). In legacy mode also check every step has an AC; in canonical mode check every sub-task was created with an `--acceptance`. Fix inline.
7. **Show to user.** Legacy mode: *"Plan written to `specs/<slug>/plan.md`. Review and tell me what to amend before we move to execution."* Canonical mode: report how many sub-tasks were created in the `<slug>` task, and that plan.md holds only Risks / Open questions (walk the steps with `/p-tasks:list`).
8. **Hand off to execution.** Once the user has approved the plan, offer: *"Ready to implement? I'll invoke `executing-plan` to work through the steps — TDD per code step, verify after each."* On **yes** → invoke `executing-plan` via the Skill tool. On **no** → stop here; the user can resume later (`executing-plan` picks up at the first unfinished step). Do not start writing code from this skill.

## Plan templates

Three variants live in `_shared/templates/`:

- `${CLAUDE_SKILL_DIR}/../_shared/templates/plan-generic.template.md` — legacy mode, docs / research / non-code tasks. Each Step has `Acceptance` + `Files`.
- `${CLAUDE_SKILL_DIR}/../_shared/templates/plan-tdd.template.md` — legacy mode, code tasks (the default when behaviour testing is feasible). Each Step has `Test first` (RED) + `Implement` (GREEN) + `Verify` (REFACTOR-safe) + `Acceptance` + `Files`.
- `${CLAUDE_SKILL_DIR}/../_shared/templates/plan-tasks.template.md` — **canonical mode** (p-tasks present). A slim plan.md with an Overview pointer + `## Open questions` + `## Risks` and **no `## Steps`** — the step list lives in p-tasks.

The skill reads the chosen template, substitutes `{{SLUG}}`, and writes the result to `specs/<slug>/plan.md`. In legacy mode the TDD/generic choice is the user's (step 2); in canonical mode the slim template is always used and the TDD/generic choice only sets each sub-task's `kind`.

## Numbering convention

- Step numbers are **continuous across the file** and **never restart**.
- After review rounds, follow-up steps continue numbering and live in their own dated section (handled by review skills, not this one).

## Out of scope

- No time estimates.
- No code writing.
- No git operations.
- No follow-up step generation — that's `requesting-code-review` / `requesting-task-review`.
- Does not enforce TDD discipline during execution — that's the `test-driven-development` skill, invoked by Claude when actually writing code for a Step.
- p-tasks integration is gated — see `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md`. When p-tasks is present it is the canonical step store (sub-tasks replace the `## Steps` checklist); when absent, behaviour is the legacy plan.md-only flow. Creating real Jira issues still requires an explicit user yes.
- p-graph consultation is opt-in and gated — see `${CLAUDE_SKILL_DIR}/../_shared/pgraph-bridge.md`. Read-only advisory; absent graph → silent no-op; never a precondition for the plan.
