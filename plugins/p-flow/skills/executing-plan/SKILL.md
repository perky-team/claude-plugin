---
name: executing-plan
description: Use after `specs/<slug>/plan.md` is approved and you are about to implement it. Drives the `## Steps` in order — one step at a time — invoking test-driven-development for code steps and verification-before-completion after each, checking off `- [x]` only when that step's acceptance criterion is met. The execution loop between writing-plan and task-end.
allowed-tools: Read Edit Bash Glob Grep
---

# executing-plan

Walk the approved plan one step at a time. Implement → verify → check off. Never run ahead of the plan, never check off a step that isn't actually green.

**Announce at start:** *"I'm using the `executing-plan` skill to work through `plan.md` step by step — implement, verify, check off."*

## When to use

- `specs/<slug>/plan.md` exists, its `## Steps` are approved, and you're about to write code (or do the work, for a generic plan).
- Resuming a partially-done plan — pick up at the first unchecked `## Steps` item.

**Don't use when:**

- No plan exists yet → run `writing-plan` first.
- Processing review feedback (`## Review follow-ups` items) → that's `receiving-code-review`, which adds a verify-the-finding-first step this skill doesn't.

## Inputs

- `specs/<slug>/plan.md` — required. Resolve `<slug>` from the branch (`<type>/<slug>`); if the branch doesn't match, ask the user. If the file is missing, stop and point to `writing-plan`.
- `specs/<slug>/specification.md` and `feature.feature` — read for acceptance context if present.

## Procedure

Process `## Steps` items **in order**, top to bottom. For each unchecked `- [ ]` step:

1. **Announce the step.** State its number and title so the user can follow along.

2. **Classify the step.**
   - **Code step** — the step has `Test first` / `Implement` / `Verify` sub-bullets (TDD plan), or its acceptance criterion describes function / endpoint / class / handler / script behaviour → go through `test-driven-development` (invoke it via the Skill tool) BEFORE writing any production code.
   - **Non-code step** — docs / config / research (generic plan) → do the work directly; no TDD.

3. **Implement to the step's acceptance criterion.** Do only what this step asks. Don't pull work forward from later steps.

4. **Verify the step.**
   - **Code step** → invoke `verification-before-completion` via the Skill tool (runs the detected tests/lints, quotes output).
     - **Pass** → continue to step 5.
     - **Fail** → do NOT check the step off. Invoke `systematic-debugging` via the Skill tool. Resolve the failure, then re-verify. Only a green verification lets you proceed.
     - **No test suite detected** → there's nothing to run; fall back to confirming the step's own acceptance criterion directly (as for a non-code step) and say so explicitly.
   - **Non-code step** (docs / config / research) → confirm the step's acceptance criterion is met directly — the file/section exists, the command's output matches, etc. Quote the evidence. No test-suite run.

5. **Check off the step.** Edit `plan.md` to change this item's `- [ ]` to `- [x]`. Touch ONLY this step's checkbox — don't reword the step, don't reorder, don't rename canonical sections.

6. **Pause at natural checkpoints.** After a step that completes a coherent unit of behaviour, briefly tell the user what's done and what's next. Don't silently churn through all 15 steps without a word.

When every `## Steps` item is `- [x]`:

7. **Hand off.** Tell the user the plan is fully implemented and verified. Suggest the next moves: `requesting-code-review` / `requesting-task-review` for a review pass, then `/p-flow:task-end` to push and recommend an MR. Do not invoke those yourself — they're user-triggered.

## Hard rules

- **In order, one at a time.** No skipping ahead, no batching several steps before verifying.
- **Check off only on green.** A `- [x]` means the step's acceptance criterion was met — for a code step, that includes a passing `verification-before-completion` (full suite green, no regressions). Never check off on intuition.
- **Failure routes to `systematic-debugging`.** Never paper over a failing verification to keep moving.
- **Only `## Steps` is this skill's domain.** `## Review follow-ups` items belong to `receiving-code-review` (they need verify-the-finding-first). Don't execute them here.
- **Canonical plan.md sections are sacred.** Edit checkboxes only; never rename or reorder `## Steps`, `## Review follow-ups — <date>`, `## Review decisions (audit)`, `## Open questions`, `## Risks`.

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
