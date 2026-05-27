---
name: task-brainstorming
description: Use when starting a new non-trivial task to elicit requirements through dialog and produce `specs/<slug>/specification.md` (always) plus optional `feature.feature` and `adr.md`. Invoked by `/p-flow:task-start`. Hard gate — does not invoke `writing-plan` or any implementation skill until the user approves the written spec.
allowed-tools: Read Write Edit Glob Bash(git rev-parse:*)
---

# task-brainstorming

Elicit requirements and materialize them in `specs/<slug>/` using p-flow templates. Terminal action: offer to invoke `writing-plan` after user approves.

## Inputs

- `<slug>` — required. Ask if missing.
- `<type>` — optional context (`feature` / `bugfix` / `hotfix` / `chore` / `docs`), passed by `/p-flow:task-start`. Used to bias initial questions only. Does NOT select a different template.
- Short idea description — optional.

## Templates source of truth

Templates are read in this order:

1. `.claude/templates/p-flow/<file>` in the user's repo (team-customized — wins if present).
2. `${CLAUDE_SKILL_DIR}/../_shared/templates/<file>` in this plugin bundle (fallback — always available).

The three template files used:

- `specification.template.md` → `specs/<slug>/specification.md`
- `feature-spec.template.feature` → `specs/<slug>/feature.feature`
- `adr.template.md` → `specs/<slug>/adr.md`

If the user's repo has no `.claude/templates/p-flow/` (i.e. `/p-flow:init` was not run), the skill still works — it reads from the plugin bundle — but tells the user: *"Run `/p-flow:init` to materialize team-canonical templates in this repo."*

## Procedure

### 1. Precheck on `specs/<slug>/`

- Dir does not exist → create it. Go to from-scratch flow.
- Dir exists, no `specification.md` → from-scratch flow.
- `specification.md` exists with no `{{PLACEHOLDERS}}` left → switch to **refinement** mode: read the file, ask the user what to revise, edit in place.
- `specification.md` exists with `{{PLACEHOLDERS}}` still present → ask: resume filling / discard and restart / cancel.

### 2. Dialog

**One question at a time.** Adapt questions to the implied work:

- **Feature** (new user-visible behavior): problem statement, user story, actors, acceptance criteria, happy path, error handling, edge cases, validation rules.
- **Bugfix / hotfix** (broken existing behavior): reproduction steps, expected vs actual, suspected root cause area, regression coverage strategy.
- **Tech-task / chore** (refactor / migration / perf — no user-visible effect): motivation, scope (explicit in/out, non-goals), approach, NFRs, rollback plan.
- **Docs**: usually no spec needed. If non-trivial, capture: where the docs live, target audience, what's new.

The choice is made by content of the dialog, not by a discrete enum.

### 3. Decomposition check

If the request spans multiple independent subsystems, flag it. Suggest splitting into sub-tasks — each through its own `/p-flow:task-start`.

### 4. Materialization

- Always write `specs/<slug>/specification.md`.
- Write `specs/<slug>/feature.feature` only if behavioral scenarios were captured.
- Write `specs/<slug>/adr.md` only if an architectural decision needs to be documented.
- Sections that don't apply are **omitted entirely**, not filled with `N/A`. (Relaxation of the §3 rule in `rules-p-flow.template.md` for non-feature tasks.)
- Fill all `{{PLACEHOLDERS}}` from the dialog. Never leave a placeholder in the output.

### 5. Self-review

Scan produced files for:

- Placeholders still present (`{{`, `TBD`, `TODO`).
- Internal contradictions.
- Ambiguous requirements (could be interpreted two ways).
- Scope creep into adjacent work.

Fix inline.

### 6. User review gate

Say: *"Spec written in `specs/<slug>/`. Review and tell me what to change before we move to the plan."*

Wait for response. If user requests changes — apply, re-run §5.

### 7. Hand-off

On user approval, offer: *"Ready to draft the plan? I'll invoke `writing-plan` next."* On user "yes" — invoke `writing-plan` via the Skill tool, passing `<slug>` as initial context.

## Hard gates

- Do NOT invoke `writing-plan` or any implementation skill before the user approves the spec.
- Do NOT ask multiple questions in one message.
- Do NOT invent new spec sections — only use what's in the template.

## Out of scope

- Does not write code.
- Does not create `specs/repo.md` (project-wide baseline; authored once by a human; see `rules-p-flow.template.md` §3).
- Does not create `plan.md` (that's `writing-plan`'s job).
- Does not run git commands (those are slash-command skills' job).
