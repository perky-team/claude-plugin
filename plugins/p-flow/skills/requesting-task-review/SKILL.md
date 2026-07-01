---
name: requesting-task-review
description: Use after `verification-before-completion` passes and the implementation should be checked against the spec. Dispatches a task-review subagent (via Task tool with `general-purpose` + inline template) with paths to spec, feature.feature, adr.md, the branch diff (plus plan.md in legacy mode). Records accepted findings as follow-ups (p-tasks sub-tasks in canonical mode, or `plan.md` steps in legacy mode) with audit-tracked decisions. Orthogonal to `requesting-code-review` (code quality vs spec alignment).
allowed-tools: Bash(git diff:*) Bash(git status:*) Bash(git log:*) Bash(git rev-parse:*) Bash(git merge-base:*) Bash(git remote:*) Bash(grep:*) Read Write Edit Glob Task
---

# requesting-task-review

Run a spec-alignment review on the current branch's diff against `specs/<slug>/*`, triage findings, and record accepted findings as follow-ups (p-tasks sub-tasks in canonical mode, or `plan.md` steps in legacy mode).

**Announce at start:** *"I'm using the `requesting-task-review` skill to check the diff against the spec/plan for alignment."*

## Preconditions

1. **Resolve the base branch** as in `requesting-code-review` precondition 1 (try `main`, then `master`, then `git remote show origin | grep 'HEAD branch'`, then ask). Call the result `<base>`.
2. There is a diff to review. Check: `git diff <base>...HEAD` is non-empty. If empty — say: *"No diff to review."*
3. `specs/<slug>/specification.md` exists. Determine `<slug>` from the current branch name (strip the `<type>/` prefix) or ask the user. Run the p-tasks gate in `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md` to fix the mode: **legacy mode** (p-tasks absent) additionally requires `specs/<slug>/plan.md`; **canonical mode** (p-tasks present) has no `plan.md` and uses the `<slug>` p-tasks task instead.

## Procedure

### 1. Compose the brief for `task-reviewer`

Capture:

- **Spec path**: `specs/<slug>/specification.md` (required).
- **Feature path**: `specs/<slug>/feature.feature` (only if exists).
- **ADR path**: `specs/<slug>/adr.md` (only if exists).
- **Plan path**: `specs/<slug>/plan.md` — **legacy mode only**. In canonical mode there is no plan.md; omit this path entirely (the reviewer checks the diff against `specification.md` acceptance criteria + `feature.feature`, and skips the plan-step table).
- **Diff command**: `git diff $(git merge-base <base> HEAD)...HEAD` where `<base>` is the branch resolved in precondition 1.

### 2. Dispatch the agent

Use the Task tool with `subagent_type: general-purpose`. Assemble the prompt in this order:

1. Read the template at `${CLAUDE_SKILL_DIR}/task-reviewer.md` (the file colocated with this SKILL.md) and inline its full content verbatim at the top.
2. Append a `---` separator and then a `## Brief` section containing the spec/plan paths above and the diff command. In legacy mode that includes the `plan.md` path; in canonical mode omit it (no plan.md exists — pass only `specification.md`, plus `feature.feature`/`adr.md` if present).

This dispatches `general-purpose` with task-reviewer instructions — works whether or not the p-flow plugin is installed in the target session.

### 3. Receive findings

The agent returns a Markdown report with sections: Acceptance criteria coverage, Feature scenarios (if applicable), Plan step status, Scope creep, Summary. Show verbatim before triage.

### 4. Triage protocol

Same severity-aware protocol as `requesting-code-review` (§4). The three severities are **blocker / suggestion / nit** — the same model the code review uses. Map task-review findings as:

- "missing AC" / "missing scenario" / "unhandled @error" → severity **blocker**, one at a time.
- "partial AC" / "partial scenario" / "unchecked low-priority step" → severity **suggestion**, batch with indices.
- "scope creep" → severity **suggestion** as well (so it lands in the audit log on `defer`/`reject` and can be converted to a follow-up on `fix`). Default action: `defer` with reason "acknowledged" if the user replies with `none`.

For each triage outcome (mode resolved by the p-tasks gate in `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md`, exactly as in `requesting-code-review` §5):

- `fix`:
  - **Legacy mode** → append `[ ]` step in `## Review follow-ups — <YYYY-MM-DD>` with continuing numbering. Format:

    ```markdown
    N. [ ] Fix: <short summary> (task-review, <severity>)
       - **Acceptance**: <derived from the missing AC / scenario / step>
    ```

  - **Canonical mode** (p-tasks present) → via the Skill tool, `p-tasks:add sub-task <parent>` with `--title "Fix: <short summary>"`, `--origin task-review:<severity>`, and `--acceptance "<derived from the missing AC / scenario / step>"`. No `plan.md` exists to hold a `## Review follow-ups` section. (Warn per the bridge doc before creating Jira issues.)

- `defer` / `reject`:
  - **Legacy mode** → audit bullet in `## Review decisions (audit)` in `plan.md`:

    ```markdown
    - task-review <severity> "<short summary>" — **<deferred|rejected>**: <reason>
    ```

  - **Canonical mode** → the audit lives in p-tasks, not a `plan.md`. Via the Skill tool, `p-tasks:add sub-task <parent>` with `--title "<short summary>"`, `--origin task-review:<severity>`, `--status done`, and `--resolution "deferred: <reason>"` / `"rejected: <reason>"`. The done sub-task carrying a `resolution` is the audit entry; never create or write to `plan.md`.

### 5. Close the loop

Same as `requesting-code-review` §6.

## Coordination with `requesting-code-review`

Both skills record findings the same way, so the user applies one mental model to both reports:

- **Legacy mode** — both triage into the **same `plan.md`** sections (`## Review follow-ups — <date>` and `## Review decisions (audit)`). Numbering is continuous regardless of which review produced the step. Findings from both skills can coexist in the same dated section if they happen on the same day.
- **Canonical mode** — both record findings as p-tasks sub-tasks under the `<slug>` task: accepted → `--origin <code-review|task-review>:<severity>`; deferred/rejected → the same origin plus `--status done --resolution "deferred|rejected: <reason>"`. No `plan.md` exists in this mode.

## What this skill does NOT do

- Does not comment on code quality / style / security (that's `requesting-code-review`).
- Does not fix anything itself.
- Does not push or create MRs.
