---
name: writing-plan
description: Use after a spec exists at `specs/<slug>/specification.md` to produce a step-by-step implementation plan — as p-tasks sub-tasks when p-tasks is present (no plan.md), or `specs/<slug>/plan.md` when it is absent. Refuses to write a step without an acceptance criterion. Decomposes work into 5–15 steps; flags larger work for sub-task split.
allowed-tools: Read Write Edit Bash(git rev-parse:*) Bash(test:*)
---

# writing-plan

Turn the brainstorm artifact into a concrete, ordered plan. Where the plan lives depends on the p-tasks gate: **p-tasks sub-tasks when p-tasks is present (no `plan.md`)**, or `specs/<slug>/plan.md` when it is absent.

**Announce at start:** *"I'm using the `writing-plan` skill to turn the spec into an implementation plan."*

## Inputs

- `specs/<slug>/specification.md` — required. If missing, stop and tell the user to run `task-brainstorming` first.
- `specs/<slug>/feature.feature` — optional, read if present.
- `specs/<slug>/adr.md` — optional, read if present.

## Procedure

1. **Read the spec(s)** in full.

1a. **Run the p-tasks gate** in `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md`. This decides where the step list will live:
   - **p-tasks absent** → *legacy mode*: the step list is a `## Steps` checklist written into `specs/<slug>/plan.md` (steps 3–8 below, "legacy mode" branch). Behave exactly as before — say nothing about p-tasks.
   - **p-tasks present** → *canonical mode*: p-tasks is the single source of truth for the step list. You will create the parent task + one sub-task per step there. **Do NOT write `plan.md`** — nothing in canonical mode creates or requires it; the narrative already lives in `specs/<slug>/specification.md` and a concise Overview goes into the parent task's `--description`. Follow the "canonical mode" branch in steps 3–8.

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

   **Canonical mode (p-tasks present):** The steps live in p-tasks. **Write no `plan.md`** — there is none in this mode.
   - If the `.ptasks.json` destination is `jira`, first warn per the bridge doc (*"This creates real Jira issues."*) and proceed only on an explicit yes. For an `fs` destination, proceed as part of the normal flow (local, reversible — no separate prompt).
   - Via the Skill tool, invoke `p-tasks:add` to create the parent `task` with `--title "<slug>"` and `--description` = a concise Overview of the task (the first sentence of the spec `## Overview` / `## Problem Statement`). This parent description is where the canonical-mode Overview lives — the rest of the narrative (Risks, Open questions) stays in `specs/<slug>/specification.md`.
   - For each step, via the Skill tool invoke `p-tasks:add` to create `sub-task <parent-id>` with `--title "<step title>"`, `--acceptance "<the step's acceptance criterion>"`, `--files "<comma list of expected files>"`, `--kind <code|non-code>` (per step 2), and `--origin plan`.
   - Do **not** create `specs/<slug>/plan.md` and do **not** read any plan template — the parent task's description + its sub-tasks + `specification.md` are the complete plan.

6. **Self-review:** scan for placeholders (`TBD`, `TODO`, leftover `<...>` markers, internal contradictions). In legacy mode also check every step has an AC; in canonical mode check every sub-task was created with an `--acceptance`. Fix inline.
7. **Show to user.** Legacy mode: *"Plan written to `specs/<slug>/plan.md`. Review and tell me what to amend before we move to execution."* Canonical mode: report how many sub-tasks were created in the `<slug>` task, and that the plan lives entirely in p-tasks (no `plan.md`) with the narrative in `specification.md` — walk the steps with `/p-tasks:list`.
8. **Hand off to execution.** Once the user has approved the plan, offer the two execution modes: *"Ready to implement? I can run `executing-plan` (inline — I implement in this session, TDD per code step, verify after each) or `subagent-driven-development` (a fresh implementer subagent per step, reviewed after each, keeping the main context clean). Which do you prefer?"* On a choice → invoke the chosen skill via the Skill tool. On **no** → stop here; the user can resume later (either skill picks up at the first unfinished step). Do not start writing code from this skill.

## Plan templates

Templates apply to **legacy mode only** — canonical mode writes no `plan.md`, so it reads no template. Two variants live in `_shared/templates/`:

- `${CLAUDE_SKILL_DIR}/../_shared/templates/plan-generic.template.md` — legacy mode, docs / research / non-code tasks. Each Step has `Acceptance` + `Files`.
- `${CLAUDE_SKILL_DIR}/../_shared/templates/plan-tdd.template.md` — legacy mode, code tasks (the default when behaviour testing is feasible). Each Step has `Test first` (RED) + `Implement` (GREEN) + `Verify` (REFACTOR-safe) + `Acceptance` + `Files`.

In legacy mode the skill reads the chosen template, substitutes `{{SLUG}}`, and writes the result to `specs/<slug>/plan.md`; the TDD/generic choice is the user's (step 2). In canonical mode no template is read — the TDD/generic choice only sets each sub-task's `kind`.

## Numbering convention

- Step numbers are **continuous across the file** and **never restart**.
- After review rounds, follow-up steps continue numbering and live in their own dated section (handled by review skills, not this one).

## Out of scope

- No time estimates.
- No code writing.
- No git operations.
- No follow-up step generation — that's `requesting-code-review` / `requesting-task-review`.
- Does not enforce TDD discipline during execution — that's the `test-driven-development` skill, invoked by Claude when actually writing code for a Step.
- p-tasks integration is gated — see `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md`. When p-tasks is present it is the canonical step store (sub-tasks are the whole plan; no `plan.md` is written); when absent, behaviour is the legacy plan.md-only flow. Creating real Jira issues still requires an explicit user yes.
- p-graph consultation is opt-in and gated — see `${CLAUDE_SKILL_DIR}/../_shared/pgraph-bridge.md`. Read-only advisory; absent graph → silent no-op; never a precondition for the plan.
