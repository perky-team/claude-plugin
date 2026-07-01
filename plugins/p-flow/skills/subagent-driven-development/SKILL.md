---
name: subagent-driven-development
description: Use to execute an approved plan in the current session by dispatching a fresh implementer subagent per step, a per-step review (spec compliance + code quality) after each, and a broad whole-branch review at the end. The isolated alternative to executing-plan — fresh context per step, artifacts handed over as files so the controller's context stays clean. Steps come from plan.md `## Steps` (legacy) or p-tasks sub-tasks (canonical).
allowed-tools: Read Write Edit Bash(git rev-parse:*) Bash(git log:*) Bash(git diff:*) Bash(git status:*) Bash(git merge-base:*) Bash(git rev-list:*) Bash(mkdir:*) Task Skill
---

# subagent-driven-development

Execute the approved plan one step at a time, but delegate each step to a **fresh subagent** with exactly the context it needs — then review that step before moving on. You are the controller: you never write production code yourself, you dispatch, review, and record.

**Announce at start:** *"I'm using the `subagent-driven-development` skill to execute the plan — a fresh implementer subagent per step, reviewed after each."*

## When to use

- The plan is approved and its steps are mostly independent, and you want per-step context isolation + automatic review checkpoints without leaving this session.
- Resuming a partially-done plan — pick up at the first step that isn't done.

**Don't use when:**

- You want to implement inline in the current context (tightly-coupled steps, small plan, you want to watch every edit) → use `executing-plan` instead. That is the inline sibling; this skill is the isolated alternative.
- No plan exists yet → run `writing-plan` first.
- Processing review findings (`## Review follow-ups` / `origin: code-review:*`) → that's `receiving-code-review`.

## Inputs

- `specs/<slug>/plan.md` — required. Resolve `<slug>` from the branch (`<type>/<slug>`); if it doesn't match, ask the user. Missing → stop, point to `writing-plan`.
- `specs/<slug>/specification.md` / `feature.feature` — read once for the goal and global constraints.
- A feature branch (not `main`/`master`/`develop`). A worktree is recommended for long runs — see `using-git-worktrees`.

## Mode — where the step list and statuses live

Run the p-tasks gate in `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md`:

- **p-tasks absent (legacy mode)** → the step list is the `## Steps` checklist in `plan.md`; you check off `- [x]` there.
- **p-tasks present (canonical mode)** → the step list lives in p-tasks. Resolve the parent by title == `<slug>` and enumerate `origin: plan` sub-tasks in document order via the Skill tool `p-tasks:list <parent>`; you mark each `--status done`.

This is also your **progress ledger**: after any compaction, trust the ledger (`p-tasks:list` or the plan.md checkboxes) and `git log` over your own recollection — steps recorded done are DONE, do not re-dispatch them.

## Workspace

Create `.p-flow/sdd/` at the repo root once, with a self-ignoring `.gitignore`:

```
mkdir -p .p-flow/sdd && printf '*\n' > .p-flow/sdd/.gitignore
```

All briefs, diffs, and reports go here so they never enter your context or `git status`.

## Procedure

1. **Read the plan once. Note the global constraints** (exact values/formats/relationships from the spec) — you will hand these to reviewers verbatim. Build the ordered step list per Mode.

2. **Pre-flight plan review.** Scan the plan once for steps that contradict each other or the constraints. If you find any, present them to the user as one batched question before starting. If clean, proceed silently.

For each step that is not done, **in order, one at a time**:

3. **Write the task brief.** Extract this step's full text (title, acceptance criterion, expected files, and any TDD sub-bullets) into `.p-flow/sdd/task-<n>-brief.md`. Record `BASE` = current HEAD (`git rev-parse HEAD`).

4. **Dispatch the implementer.** Use the `Task` tool with `subagent_type: general-purpose` and `model` chosen per **Model selection**. Build the prompt by reading `${CLAUDE_SKILL_DIR}/implementer-prompt.md` and filling its placeholders — pass the brief path and a report path (`.p-flow/sdd/task-<n>-report.md`), not the pasted step text. Add only: where this step fits, interfaces/decisions from earlier steps, and your resolution of any ambiguity.

5. **Handle the implementer's status** (see **Handling implementer status**). Only a `DONE` (or resolved `DONE_WITH_CONCERNS`) proceeds to review.

6. **Build the review package.** Write the commit list, stat, and full diff for `BASE..HEAD` to a file:

   ```
   git log --oneline BASE..HEAD > .p-flow/sdd/review-<n>.diff
   git diff --stat BASE..HEAD >> .p-flow/sdd/review-<n>.diff
   git diff -U10 BASE..HEAD >> .p-flow/sdd/review-<n>.diff
   ```

   Use the `BASE` you recorded in step 3 — never `HEAD~1` (it drops all but the last commit of a multi-commit step). If redirection isn't available, run each `git` command and `Write` the combined output to the file.

7. **Dispatch the task reviewer.** `Task` + `general-purpose` + `model` per role. Read `${CLAUDE_SKILL_DIR}/task-reviewer-prompt.md`, fill it with the brief path, the report path, the review-package path, and the global constraints verbatim. The reviewer returns a spec-compliance verdict + `Blockers / Suggestions / Nits`.

8. **Review loop.** If the reviewer reports spec ❌ or any Blocker: dispatch ONE fix subagent (same `general-purpose` + implementer contract) with the complete findings list, appending its fix report to the same report file. Rebuild the package (step 6) and re-review. Repeat until spec ✅ with no open Blockers. Resolve any ⚠️ "cannot verify from diff" items yourself — you hold the cross-step context.

9. **Record completion.**
   - **Legacy mode:** edit `plan.md`, flip this step's `- [ ]` to `- [x]`. Touch only this checkbox.
   - **Canonical mode:** via the Skill tool, `p-tasks:set <st-id> --status done`.

When every step is done:

10. **Final whole-branch review.** Build a package for `MERGE_BASE..HEAD` (`git merge-base <base> HEAD`). Dispatch `general-purpose` with the canonical template `${CLAUDE_SKILL_DIR}/../requesting-code-review/code-reviewer.md` + the package path. If it returns findings, dispatch ONE fix subagent with the complete list (not one per finding), then re-verify. Log the outcomes as review follow-ups the same way `requesting-code-review` does (via the p-tasks gate).

11. **Hand off.** Tell the user the plan is fully implemented and reviewed. Suggest `/p-flow:task-end` to push and recommend an MR. Do not push yourself.

## Model selection

Specify `model` on **every** dispatch. Use the least powerful model that fits the role:

- **Mechanical implementation** (1–2 files, complete spec, plan contains the code) → cheapest tier.
- **Integration / multi-file / judgment** → mid tier.
- **The final whole-branch review** → the most capable tier.
- **Per-step reviewers** → scale to the diff: a small mechanical diff needs a mid tier; a subtle change needs the capable tier.

An omitted `model` silently inherits the session's model (often the most expensive) — never omit it.

## Handling implementer status

- **DONE** → build the package and review.
- **DONE_WITH_CONCERNS** → read the concerns first. Correctness/scope concerns: resolve before review. Observations: note and proceed.
- **NEEDS_CONTEXT** → provide the missing context, re-dispatch.
- **BLOCKED** → assess: context problem → add context, re-dispatch same model; needs more reasoning → re-dispatch a stronger model; too large → split; plan is wrong → escalate to the user. Never force the same model to retry unchanged.

## Hard rules

- **You are the controller — you do not write production code.** Dispatch, review, record. Fixing "manually" pollutes your context; dispatch a fix subagent instead.
- **One implementer at a time.** Parallel implementers conflict on the working tree.
- **Hand artifacts over as files.** Never paste a step's full text or a diff into a dispatch prompt — pass the brief/package/report paths.
- **Mark done only on green.** A step is done only after spec ✅ and no open Blockers (for a code step, that includes the implementer's own passing tests).
- **Every dispatch names a model.** See Model selection.
- **Don't pre-judge for the reviewer.** Never tell a reviewer what not to flag or pre-rate a finding's severity — adjudicate in the review loop.
- **Respect the p-tasks gate.** Steps and statuses live where the gate says (p-tasks or plan.md checkboxes); don't invent a second store.

## Red flags — STOP

- "I'll just fix this small thing myself instead of dispatching" → no; that's context pollution — dispatch a fix subagent.
- "I'll paste the whole plan into the subagent so it has context" → no; hand it the task brief file only.
- "Steps 1–3 are quick, I'll dispatch all three then review" → no; one step, reviewed, done, before the next.
- "The reviewer will probably say it's fine, I'll skip it" → no; the per-step review is the gate.
- "I'll mark it done and the final review will catch anything" → no; `- [x]` / `--status done` requires this step's own green review.

## What this skill does NOT do

- Does not write the plan — that's `writing-plan`.
- Does not run inline in the current context — that's `executing-plan` (the sibling; use it when you don't want subagents).
- Does not push or open an MR — that's `/p-flow:task-end`.
- Does not itself write production code or run the suite — the implementer subagents do (following `test-driven-development`).
- Does not use registered subagents — all dispatch is `Task` + `general-purpose` + inline template content.
