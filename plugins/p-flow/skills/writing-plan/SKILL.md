---
name: writing-plan
description: Use after a spec exists at `specs/<slug>/specification.md` to produce a step-by-step implementation plan at `specs/<slug>/plan.md`. Refuses to write a step without an acceptance criterion. Decomposes work into 5–15 steps; flags larger work for sub-task split.
allowed-tools: Read Write Edit Glob
---

# writing-plan

Turn the brainstorm artifact into a concrete, ordered plan. One file: `specs/<slug>/plan.md`.

## Inputs

- `specs/<slug>/specification.md` — required. If missing, stop and tell the user to run `task-brainstorming` first.
- `specs/<slug>/feature.feature` — optional, read if present.
- `specs/<slug>/adr.md` — optional, read if present.

## Procedure

1. **Read the spec(s)** in full.
2. **Decompose into 5–15 steps.** If you find yourself with more than 15, stop and tell the user the work is too large for one plan — suggest splitting into sub-tasks, each via its own `/p-flow:task-start`.
3. **Every step must have an acceptance criterion.** Concrete and checkable: "tests `X.py::test_foo` and `X.py::test_bar` pass", "endpoint `GET /foo` returns 200 with body matching schema Y", "file `bar.ts` exports the function `baz`". Refuse to write a step without one — ask the user for a criterion instead.
4. **Self-review:** scan the produced file for placeholders (`TBD`, `TODO`, `...`), steps without AC, internal contradictions. Fix inline.
5. **Show to user.** Ask: "Plan written to `specs/<slug>/plan.md`. Review and tell me what to amend before we move to execution."

## Plan template

Write this content into `specs/<slug>/plan.md`:

```markdown
# Plan — <slug>

## Steps

1. [ ] <action — what to do>
   - **Acceptance**: <how to know this step is done — concrete and checkable>
   - **Files**: <expected affected files>

2. [ ] <action>
   - **Acceptance**: ...
   - **Files**: ...

## Open questions

- <questions that block or could change the plan>

## Risks

- <known risks, with mitigation if any>
```

## Numbering convention

- Step numbers are **continuous across the file** and **never restart**.
- After review rounds, follow-up steps continue numbering and live in their own dated section (handled by review skills, not this one).

## Out of scope

- No time estimates.
- No code writing.
- No git operations.
- No follow-up step generation — that's `requesting-code-review` / `requesting-task-review`.
