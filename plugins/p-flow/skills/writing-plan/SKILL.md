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
2. **Detect plan type and ask the user.** Examine the spec to suggest a variant:
   - If `specs/<slug>/feature.feature` exists OR `specification.md` Acceptance Criteria mention function / endpoint / class / handler / script behaviours → suggest **TDD plan** (template: `${CLAUDE_SKILL_DIR}/../_shared/templates/plan-tdd.template.md`).
   - Otherwise → suggest **generic plan** (template: `${CLAUDE_SKILL_DIR}/../_shared/templates/plan-generic.template.md`).

   Ask the user (in prose, no AskUserQuestion):
   *"Based on the spec, I'd suggest a **<TDD|generic>** plan. Confirm, or override with the other variant?"*

   Wait for explicit answer before proceeding.
3. **Decompose into 5–15 steps.** If you find yourself with more than 15, stop and tell the user the work is too large for one plan — suggest splitting into sub-tasks, each via its own `/p-flow:task-start`.
4. **Every step must have an acceptance criterion.** Concrete and checkable: "tests `X.py::test_foo` and `X.py::test_bar` pass", "endpoint `GET /foo` returns 200 with body matching schema Y", "file `bar.ts` exports the function `baz`". Refuse to write a step without one — ask the user for a criterion instead. For TDD plans, each step also requires `Test first` / `Implement` / `Verify` sub-bullets.
5. **Self-review:** scan the produced file for placeholders (`TBD`, `TODO`, leftover `<...>` markers from the template, steps without AC, internal contradictions). Fix inline.
6. **Show to user.** Ask: "Plan written to `specs/<slug>/plan.md`. Review and tell me what to amend before we move to execution."
7. **(optional) Offer to mirror into p-tasks.** Run the gate in `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md`. If p-tasks is **not** active, skip this step silently. If it **is** active, after the user has approved the plan, offer:

   *"p-tasks is set up in this repo. Want me to create a `<slug>` task there with one sub-task per plan step?"* (If the `.ptasks.json` destination is `jira`, add the real-Jira-issues warning from the bridge doc.)

   On an explicit **yes**:
   - Via the Skill tool, invoke `p-tasks:add` to create `task` with `--title "<slug>"` and an optional `--description` = the first sentence of the spec `## Overview` / `## Problem Statement`. Capture the returned parent id (`t-N`).
   - For each item under `## Steps` in `specs/<slug>/plan.md`, via the Skill tool invoke `p-tasks:add` to create `sub-task <parent-id>` with `--title "<the step's title>"`.
   - Confirm to the user how many sub-tasks were created.

   On **no** (or decline): continue — the plan is already written and complete. Mirroring is never a precondition for finishing `writing-plan`.

## Plan templates

Two variants live in `_shared/templates/`:

- `${CLAUDE_SKILL_DIR}/../_shared/templates/plan-generic.template.md` — for docs / research / non-code tasks. Each Step has `Acceptance` + `Files`.
- `${CLAUDE_SKILL_DIR}/../_shared/templates/plan-tdd.template.md` — for code tasks (the default when behaviour testing is feasible). Each Step has `Test first` (RED) + `Implement` (GREEN) + `Verify` (REFACTOR-safe) + `Acceptance` + `Files`.

The skill reads the chosen template, substitutes `{{SLUG}}`, and writes the result to `specs/<slug>/plan.md`.

## Numbering convention

- Step numbers are **continuous across the file** and **never restart**.
- After review rounds, follow-up steps continue numbering and live in their own dated section (handled by review skills, not this one).

## Out of scope

- No time estimates.
- No code writing.
- No git operations.
- No follow-up step generation — that's `requesting-code-review` / `requesting-task-review`.
- Does not enforce TDD discipline during execution — that's the `test-driven-development` skill, invoked by Claude when actually writing code for a Step.
- p-tasks mirroring is opt-in and gated — see `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md`. Never created without an explicit user yes.
