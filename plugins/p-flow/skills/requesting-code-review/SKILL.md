---
name: requesting-code-review
description: Use after `verification-before-completion` passes and there is a diff worth reviewing. Dispatches a code-review subagent (via Task tool with `general-purpose` + inline template) on the branch diff, then leads the user through severity-aware triage and writes accepted findings into `plan.md` as follow-up steps with audit-tracked decisions.
allowed-tools: Bash(git diff:*) Bash(git status:*) Bash(git log:*) Bash(git rev-parse:*) Bash(git merge-base:*) Read Write Edit Glob Task
---

# requesting-code-review

Run a code-quality review on the current branch's diff, triage the findings, and integrate accepted findings into `plan.md`.

## Preconditions

1. **Resolve the base branch** for the diff: try `main` first, then `master`. If neither exists locally → run `git remote show origin | grep 'HEAD branch'` to read the remote's default; use that. If that also fails → ask the user for the base branch name. Call the result `<base>`.
2. There is a diff to review. Check: `git diff <base>...HEAD` shows non-empty output. If empty — say: *"No diff to review. Run after implementing some steps."*
3. `specs/<slug>/specification.md` and `specs/<slug>/plan.md` exist. Determine `<slug>` from the current branch name (strip the `<type>/` prefix) or ask the user.

## Procedure

### 1. Compose the brief for `code-reviewer`

Capture:

- **Goal**: one paragraph distilled from `specification.md` "Overview / Problem Statement / Proposed Solution".
- **What was done**: the list of checked items under `## Steps` in `plan.md` (do not include follow-ups or audit entries).
- **Focus areas**: by default — correctness, security, dead code, style consistency. If the user requested specific focus, prepend it.
- **Diff command**: `git diff $(git merge-base <base> HEAD)...HEAD` where `<base>` is the branch resolved in precondition 1. Use `git rev-parse --abbrev-ref HEAD` to know the current branch.

### 2. Dispatch the agent

Use the Task tool with `subagent_type: general-purpose`. The prompt MUST be assembled in this order:

1. Read the template at `${CLAUDE_SKILL_DIR}/code-reviewer.md` (the file colocated with this SKILL.md) and inline its full content verbatim at the top of the prompt.
2. Append a `---` separator and then a `## Brief` section containing the goal, what-was-done, focus areas, diff command, and the literal paths to `specification.md` and `plan.md` composed above.

This dispatches `general-purpose` with code-reviewer instructions — works whether or not the p-flow plugin is installed in the target session.

### 3. Receive findings

The agent returns a structured Markdown report with `### Blockers`, `### Suggestions`, `### Nits`. Show it to the user verbatim before triage.

### 4. Triage protocol (explicit — avoids AskUserQuestion 4-option limit)

For each severity, follow exactly this protocol:

- **Blockers**: one at a time. For each, ask the user with three options: `fix` / `defer` / `reject`. If `defer` or `reject` — require a one-line reason. No defaults — user must answer.

- **Suggestions**: present as a numbered list (up to 10 per batch). Ask the user once: *"Reply with comma-separated indices to fix (e.g. `1,3,5`), or `all`, or `none`. Items not selected default to `defer` with reason 'not selected'. You may add explicit reject reasons inline like `2:reject (false positive: X)`."*

- **Nits**: present as a numbered list. Ask once: *"Reply with comma-separated indices to opt-in for fixing, or `none`. Default action is `reject all` with reason 'nit declined'."*

### 5. Update `plan.md`

For each `fix` → append a new `[ ]` step in the `## Review follow-ups — <YYYY-MM-DD>` section. Continue the existing step numbering (never restart). If the section for today's date does not exist — create it just after `## Steps`. Each follow-up:

```markdown
N. [ ] Fix: <short summary> (code-review, <severity>)
   - **Acceptance**: <derived from the agent's suggested fix>
```

For each `defer` / `reject` → append a bullet to `## Review decisions (audit)` (create the section just before `## Open questions` if missing):

```markdown
- code-review <severity> "<short summary>" — **<deferred|rejected>**: <reason>
```

### 6. Close the loop

Tell the user: *"Plan updated. New steps: N1, N2, … When ready to fix, say 'continue' and pick them up (you can implement manually, or wait for `executing-plan` in Wave 2)."*

## What this skill does NOT do

- Does not push, tag, or create MRs (that's `task-end`).
- Does not run the agent on uncommitted changes if the user wants a *committed* review — by default it reviews `merge-base...HEAD`, which includes committed work only. If the user wants to include unstaged changes, switch to `git diff HEAD` and tell the user explicitly.
- Does not fix anything itself.
