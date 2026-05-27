---
name: requesting-task-review
description: Use after `verification-before-completion` passes and the implementation should be checked against the spec. Dispatches the `task-reviewer` subagent with paths to spec, feature.feature, adr.md, plan.md, and the branch diff. Triages findings into `plan.md` follow-ups with audit-tracked decisions. Orthogonal to `requesting-code-review` (code quality vs spec alignment).
allowed-tools: Bash(git diff:*) Bash(git status:*) Bash(git log:*) Bash(git rev-parse:*) Bash(git merge-base:*) Read Write Edit Glob Agent
---

# requesting-task-review

Run a spec-alignment review on the current branch's diff against `specs/<slug>/*`, triage findings, and integrate accepted findings into `plan.md`.

## Preconditions

1. There is a diff to review. Same check as `requesting-code-review`.
2. `specs/<slug>/specification.md` and `specs/<slug>/plan.md` exist. Determine `<slug>` from the current branch name (strip the `<type>/` prefix) or ask the user.

## Procedure

### 1. Compose the brief for `task-reviewer`

Capture:

- **Spec path**: `specs/<slug>/specification.md` (required).
- **Feature path**: `specs/<slug>/feature.feature` (only if exists).
- **ADR path**: `specs/<slug>/adr.md` (only if exists).
- **Plan path**: `specs/<slug>/plan.md` (required).
- **Diff command**: `git diff $(git merge-base main HEAD)...HEAD` (use `master` if no `main`).

### 2. Dispatch the agent

Use the Agent tool with `subagent_type: task-reviewer`. Pass the four paths and the diff command.

### 3. Receive findings

The agent returns a Markdown report with sections: Acceptance criteria coverage, Feature scenarios (if applicable), Plan step status, Scope creep, Summary. Show verbatim before triage.

### 4. Triage protocol

Same severity-aware protocol as `requesting-code-review` (§4):

- "missing AC" / "missing scenario" / "unhandled @error" → severity **blocker**, one at a time.
- "partial AC" / "partial scenario" / "unchecked low-priority step" → severity **suggestion**, batch with indices.
- "scope creep" / "note" → severity **note**, default `defer` with reason "acknowledged"; user opts in to convert to plan step.

For each triage outcome:

- `fix` → append `[ ]` step in `## Review follow-ups — <YYYY-MM-DD>` with continuing numbering. Format:

```markdown
N. [ ] Fix: <short summary> (task-review, <severity>)
   - **Acceptance**: <derived from the missing AC / scenario / step>
```

- `defer` / `reject` → audit bullet:

```markdown
- task-review <severity> "<short summary>" — **<deferred|rejected>**: <reason>
```

### 5. Close the loop

Same as `requesting-code-review` §6.

## Coordination with `requesting-code-review`

Both skills triage into the **same `plan.md`** sections (`## Review follow-ups — <date>` and `## Review decisions (audit)`). Numbering is continuous regardless of which review produced the step. Findings from both skills can coexist in the same dated section if they happen on the same day.

## What this skill does NOT do

- Does not comment on code quality / style / security (that's `requesting-code-review`).
- Does not fix anything itself.
- Does not push or create MRs.
