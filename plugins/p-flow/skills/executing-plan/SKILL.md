---
name: executing-plan
description: Use after the plan is approved and you are about to implement it. Drives the steps in order — one at a time — invoking test-driven-development for code steps and verification-before-completion after each, marking a step done only when its acceptance criterion is met. Steps live in plan.md `## Steps` (legacy) or, when p-tasks is present, as its sub-tasks. The execution loop between writing-plan and task-end.
allowed-tools: Read Edit Bash Glob Grep TaskCreate TaskUpdate TaskList TodoWrite
---

# executing-plan

Walk the approved plan one step at a time. Implement → verify → check off. Never run ahead of the plan, never check off a step that isn't actually green.

**Announce at start:** *"I'm using the `executing-plan` skill to work through the plan step by step — implement, verify, check off."*

## When to use

- The plan is approved and you're about to write code (or do the work, for a generic plan). The steps are either the `## Steps` checklist in `specs/<slug>/plan.md` (legacy) or the `<slug>` task's sub-tasks in p-tasks (canonical — see "Mode" below).
- Resuming a partially-done plan — pick up at the first step that isn't done. In legacy mode that's the first unchecked `## Steps` item. In canonical mode the ledger has **three** states, and you must reconcile before continuing (see "Resuming — reconcile in_progress" below): a `done` sub-task is verified-complete (skip it), a `todo` sub-task is genuinely untouched, and an **`in_progress` sub-task was INTERRUPTED mid-step** — do not assume it's done and do not blindly re-run it.

**Don't use when:**

- No plan exists yet → run `writing-plan` first.
- Processing review feedback (`## Review follow-ups` items) → that's `receiving-code-review`, which adds a verify-the-finding-first step this skill doesn't.

## Inputs

Resolve `<slug>` from the branch (`<type>/<slug>`); if the branch doesn't match, ask the user. Required inputs depend on the mode (see "Mode" below — run the p-tasks gate first):

- **Legacy mode (p-tasks absent):** `specs/<slug>/plan.md` — required. If the file is missing, stop and point to `writing-plan`.
- **Canonical mode (p-tasks present):** `specs/<slug>/specification.md` (context) + the p-tasks parent task titled `<slug>` (the step list). There is **no `plan.md`** — do not look for one or stop on its absence. If the `<slug>` parent task is missing, stop and point to `writing-plan`.
- `specs/<slug>/specification.md` and `feature.feature` — read for acceptance context if present (in canonical mode `specification.md` is the primary context source).

## Mode — where the step list lives

Run the p-tasks gate in `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md`:

- **p-tasks absent (legacy mode)** → the step list is the `## Steps` checklist in `plan.md`. Walk it as described below, checking off `- [x]` in plan.md. Behaviour is unchanged from before the bridge existed.
- **p-tasks present (canonical mode)** → the step list lives in p-tasks. Resolve the parent task by title == `<slug>` and enumerate its sub-tasks **in document order** via the Skill tool: `p-tasks:list <parent>`. Each sub-task is a step, carrying `status`, `acceptance`, `files`, `kind`, and `origin`. Work only the **`origin: plan`** sub-tasks here; sub-tasks with `origin: code-review:*` / `task-review:*` are review follow-ups owned by `receiving-code-review`. There is **no `plan.md`** at all — do not look for one, do not read it, do not write checkboxes anywhere.

The per-step loop below is identical in both modes except for a few things: how you read the next step (a `- [ ]` line vs. the next not-`done` sub-task from `p-tasks:list`), how you classify it (sub-bullets/AC vs. the sub-task's `kind`), that canonical mode marks the step `in_progress` at start (legacy has no such state), and how you record completion (check `- [x]` in plan.md vs. `p-tasks:set <st-id> --status done`).

### Resuming — reconcile `in_progress` (canonical mode)

Before picking up, read `p-tasks:list <parent>`. Statuses are the source of truth over your recollection (especially after compaction), and they carry **three** meanings:

- **`done`** → verified-complete. Skip it; never re-dispatch.
- **`todo`** → genuinely untouched. Start it normally.
- **`in_progress`** → the previous run was **INTERRUPTED** while working this step. Do **not** assume it finished, and do **not** blindly redo it from scratch. **Reconcile first:** inspect `git log` and the working tree (and any partial edits) for what already landed, verify it against the sub-task's `acceptance`, then either finish + verify it or redo it cleanly — and only then `p-tasks:set <st-id> --status done`. See `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md` § Status lifecycle.

Legacy mode has no `in_progress`: an interrupted step is indistinguishable from an unstarted one (both `- [ ]`), so just re-run the first unchecked step.

## Progress checklist (native task list)

Alongside the durable ledger, maintain Claude Code's **native task list** — the panel the user toggles with `Ctrl+T` — as a live mirror, so the user watches steps tick off as they complete. Use whichever task-list tools your Claude Code exposes: on recent versions that is **`TaskCreate`** (add a task) + **`TaskUpdate`** (change its status); older versions have the legacy **`TodoWrite`** tool (whole-list rewrite) instead. Prefer the `Task*` tools when they are available and fall back to `TodoWrite` only when they are not — do not use both, and do not silently skip this because one tool is missing.

- **At the start**, once the step list is built, create one task per plan step, in order, titled after the step. All start in the not-started state (`todo` / `pending`).
- **When you begin a step** (procedure step 1), set its task to `in_progress` (both modes — the task list has an in-progress state even though legacy plan.md checkboxes don't).
- **When you record completion** (procedure step 6, verified green), set its task to `completed`.

The native task list is a **view, not the source of truth** — the `plan.md` `## Steps` checkboxes (legacy) or the p-tasks sub-tasks (canonical) stay canonical: they carry acceptance/files/resolutions and survive across sessions. If the two ever disagree, reconcile the task list to the ledger. Keep exactly one task `in_progress` at a time. On resume, rebuild the task list from the ledger (`p-tasks:list` / the checkboxes) before continuing.

## Procedure

Process the steps **in order**, top to bottom. For each step that is not yet done (a `- [ ]` item in legacy mode; the next sub-task whose `status` ≠ `done` in canonical mode):

1. **Announce the step.** State its number and title so the user can follow along.

2. **Classify the step.**
   - **Legacy mode:** the step is a **code step** if it has `Test first` / `Implement` / `Verify` sub-bullets (TDD plan) or its acceptance criterion describes function / endpoint / class / handler / script behaviour; otherwise it's a **non-code step** (docs / config / research).
   - **Canonical mode:** read the sub-task's `kind` — `code` → code step, `non-code` → non-code step. An absent `kind` defaults to `code`. (Its `acceptance` is the criterion; `files` lists the expected files.)
   - **Code step** → go through `test-driven-development` (invoke it via the Skill tool) BEFORE writing any production code. **Non-code step** → do the work directly; no TDD.

3. **Mark the step `in_progress` (canonical mode).** Before writing anything, set the sub-task in flight via the Skill tool: `p-tasks:set <st-id> --status in_progress`. On the **first** step, also move the parent if it's still `todo`: `p-tasks:set <parent> --status in_progress` (no cascade — set it once, explicitly). This makes the tracker show exactly what is being worked, and — if the run is interrupted here — leaves the step distinguishable from a never-started one. **Legacy mode:** skip this — plan.md checkboxes are binary and cannot express in-progress. See `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md` § Status lifecycle.

4. **Implement to the step's acceptance criterion.** Do only what this step asks. Don't pull work forward from later steps.

5. **Verify the step.**
   - **Code step** → invoke `verification-before-completion` via the Skill tool (runs the detected tests/lints, quotes output).
     - **Pass** → continue to step 6.
     - **Fail** → do NOT mark the step done. Invoke `systematic-debugging` via the Skill tool. Resolve the failure, then re-verify. Only a green verification lets you proceed. (Leave the sub-task `in_progress` while you debug — that is exactly what it means.)
     - **No test suite detected** → there's nothing to run; fall back to confirming the step's own acceptance criterion directly (as for a non-code step) and say so explicitly.
   - **Non-code step** (docs / config / research) → confirm the step's acceptance criterion is met directly — the file/section exists, the command's output matches, etc. Quote the evidence. No test-suite run.

6. **Record completion.** Only now, with the step verified green.
   - **Legacy mode:** edit `plan.md` to change this item's `- [ ]` to `- [x]`. Touch ONLY this step's checkbox — don't reword the step, don't reorder, don't rename canonical sections.
   - **Canonical mode:** via the Skill tool, `p-tasks:set <st-id> --status done` for the sub-task you just completed (it moves `in_progress → done`). Make **no** checkbox edits to plan.md (there are none).

7. **Pause at natural checkpoints.** After a step that completes a coherent unit of behaviour, briefly tell the user what's done and what's next. Don't silently churn through all 15 steps without a word.

When every step is done (every `## Steps` item is `- [x]` in legacy mode; every sub-task's `status` is `done` per `p-tasks:list <parent>` in canonical mode):

8. **Hand off.** Tell the user the plan is fully implemented and verified. Suggest the next moves: `requesting-code-review` / `requesting-task-review` for a review pass, then `/p-flow:task-end` to push and recommend an MR. Do not invoke those yourself — they're user-triggered.

## Hard rules

- **In order, one at a time.** No skipping ahead, no batching several steps before verifying.
- **Mark done only on green.** A `- [x]` (legacy) or a `--status done` (canonical) means the step's acceptance criterion was met — for a code step, that includes a passing `verification-before-completion` (full suite green, no regressions). Never mark done on intuition.
- **Set `in_progress` at step start (canonical mode).** The moment you begin a step, `p-tasks:set <st-id> --status in_progress` (and the parent on the first step). This is what makes the live step visible and an interrupted step recoverable. Never jump a canonical sub-task straight from `todo` to `done`.
- **Failure routes to `systematic-debugging`.** Never paper over a failing verification to keep moving.
- **Only the plan steps are this skill's domain.** Review follow-ups belong to `receiving-code-review` (they need verify-the-finding-first): in legacy mode that's `## Review follow-ups` items; in canonical mode it's sub-tasks with `origin` = `code-review:*` / `task-review:*`. Don't execute those here — work only the `origin: plan` steps.
- **Canonical plan.md sections are sacred (legacy mode).** In legacy mode edit checkboxes only; never rename or reorder `## Steps`, `## Review follow-ups — <date>`, `## Review decisions (audit)`, `## Open questions`, `## Risks`. In canonical mode there is **no `plan.md`** — never create or read one; the step list lives in p-tasks and the narrative in `specification.md`.

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
