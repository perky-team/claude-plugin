---
name: executing-plan
description: Use after the plan is approved and you are about to implement it. Drives the steps in order — one at a time — invoking test-driven-development for code steps and verification-before-completion after each, marking a step done only when its acceptance criterion is met. Steps live in plan.md `## Steps` (legacy) or, when p-tasks is present, as its sub-tasks. The execution loop between writing-plan and task-end.
allowed-tools: Read Edit Bash Glob Grep
---

# executing-plan

Walk the approved plan one step at a time. Implement → verify → check off. Never run ahead of the plan, never check off a step that isn't actually green.

**Announce at start:** *"I'm using the `executing-plan` skill to work through `plan.md` step by step — implement, verify, check off."*

## When to use

- The plan is approved and you're about to write code (or do the work, for a generic plan). The steps are either the `## Steps` checklist in `specs/<slug>/plan.md` (legacy) or the `<slug>` task's sub-tasks in p-tasks (canonical — see "Mode" below).
- Resuming a partially-done plan — pick up at the first step that isn't done (first unchecked `## Steps` item, or first not-`done` sub-task).

**Don't use when:**

- No plan exists yet → run `writing-plan` first.
- Processing review feedback (`## Review follow-ups` items) → that's `receiving-code-review`, which adds a verify-the-finding-first step this skill doesn't.

## Inputs

- `specs/<slug>/plan.md` — required. Resolve `<slug>` from the branch (`<type>/<slug>`); if the branch doesn't match, ask the user. If the file is missing, stop and point to `writing-plan`.
- `specs/<slug>/specification.md` and `feature.feature` — read for acceptance context if present.

## Mode — where the step list lives

Run the p-tasks gate in `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md`:

- **p-tasks absent (legacy mode)** → the step list is the `## Steps` checklist in `plan.md`. Walk it as described below, checking off `- [x]` in plan.md. Behaviour is unchanged from before the bridge existed.
- **p-tasks present (canonical mode)** → the step list lives in p-tasks. Resolve the parent task by title == `<slug>` and enumerate its sub-tasks **in document order** via the Skill tool: `p-tasks:list <parent>`. Each sub-task is a step, carrying `status`, `acceptance`, `files`, `kind`, and `origin`. Work only the **`origin: plan`** sub-tasks here; sub-tasks with `origin: code-review:*` / `task-review:*` are review follow-ups owned by `receiving-code-review`. There is **no `## Steps`** in plan.md — do not look for one and do not write checkboxes there.

The per-step loop below is identical in both modes except for two things: how you read the next step (a `- [ ]` line vs. the next not-`done` sub-task from `p-tasks:list`), how you classify it (sub-bullets/AC vs. the sub-task's `kind`), and how you record completion (check `- [x]` in plan.md vs. `p-tasks:set <st-id> --status done`).

## Procedure

Process the steps **in order**, top to bottom. For each step that is not yet done (a `- [ ]` item in legacy mode; the next sub-task whose `status` ≠ `done` in canonical mode):

1. **Announce the step.** State its number and title so the user can follow along.

2. **Classify the step.**
   - **Legacy mode:** the step is a **code step** if it has `Test first` / `Implement` / `Verify` sub-bullets (TDD plan) or its acceptance criterion describes function / endpoint / class / handler / script behaviour; otherwise it's a **non-code step** (docs / config / research).
   - **Canonical mode:** read the sub-task's `kind` — `code` → code step, `non-code` → non-code step. An absent `kind` defaults to `code`. (Its `acceptance` is the criterion; `files` lists the expected files.)
   - **Code step** → go through `test-driven-development` (invoke it via the Skill tool) BEFORE writing any production code. **Non-code step** → do the work directly; no TDD.

3. **Implement to the step's acceptance criterion.** Do only what this step asks. Don't pull work forward from later steps.

4. **Verify the step.**
   - **Code step** → invoke `verification-before-completion` via the Skill tool (runs the detected tests/lints, quotes output).
     - **Pass** → continue to step 5.
     - **Fail** → do NOT check the step off. Invoke `systematic-debugging` via the Skill tool. Resolve the failure, then re-verify. Only a green verification lets you proceed.
     - **No test suite detected** → there's nothing to run; fall back to confirming the step's own acceptance criterion directly (as for a non-code step) and say so explicitly.
   - **Non-code step** (docs / config / research) → confirm the step's acceptance criterion is met directly — the file/section exists, the command's output matches, etc. Quote the evidence. No test-suite run.

5. **Record completion.**
   - **Legacy mode:** edit `plan.md` to change this item's `- [ ]` to `- [x]`. Touch ONLY this step's checkbox — don't reword the step, don't reorder, don't rename canonical sections.
   - **Canonical mode:** via the Skill tool, `p-tasks:set <st-id> --status done` for the sub-task you just completed. Make **no** checkbox edits to plan.md (there are none).

6. **Pause at natural checkpoints.** After a step that completes a coherent unit of behaviour, briefly tell the user what's done and what's next. Don't silently churn through all 15 steps without a word.

When every step is done (every `## Steps` item is `- [x]` in legacy mode; every sub-task's `status` is `done` per `p-tasks:list <parent>` in canonical mode):

7. **Hand off.** Tell the user the plan is fully implemented and verified. Suggest the next moves: `requesting-code-review` / `requesting-task-review` for a review pass, then `/p-flow:task-end` to push and recommend an MR. Do not invoke those yourself — they're user-triggered.

## Hard rules

- **In order, one at a time.** No skipping ahead, no batching several steps before verifying.
- **Mark done only on green.** A `- [x]` (legacy) or a `--status done` (canonical) means the step's acceptance criterion was met — for a code step, that includes a passing `verification-before-completion` (full suite green, no regressions). Never mark done on intuition.
- **Failure routes to `systematic-debugging`.** Never paper over a failing verification to keep moving.
- **Only the plan steps are this skill's domain.** Review follow-ups belong to `receiving-code-review` (they need verify-the-finding-first): in legacy mode that's `## Review follow-ups` items; in canonical mode it's sub-tasks with `origin` = `code-review:*` / `task-review:*`. Don't execute those here — work only the `origin: plan` steps.
- **Canonical plan.md sections are sacred.** In legacy mode edit checkboxes only; never rename or reorder `## Steps`, `## Review follow-ups — <date>`, `## Review decisions (audit)`, `## Open questions`, `## Risks`. In canonical mode plan.md has no `## Steps` — never add one; the step list lives in p-tasks.

## Red flags — STOP

- "I'll implement steps 1–5, then verify them all at once" → no; verify per step.
- "Step 3's test fails, but step 4 will probably fix it — keep going" → no; resolve via `systematic-debugging` first.
- "I'll check the box now and circle back to make it pass" → no; `- [x]` requires green.
- "This step has no acceptance criterion, I'll just guess what done means" → stop; the plan is incomplete — send it back to `writing-plan`.

## What this skill does NOT do

- Does not write the plan — that's `writing-plan`.
- Does not push or open an MR — that's `/p-flow:task-end`.
- Does not request a review — that's `requesting-code-review` / `requesting-task-review`.
- Does not process review findings — that's `receiving-code-review`.
- Does not itself run the test suite — it delegates that to `verification-before-completion`.
