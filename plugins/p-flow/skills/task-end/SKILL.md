---
name: task-end
description: Exit point of the p-flow task development flow. Runs pre-checks (no main branch, no uncommitted changes, plan steps checked, verification marker fresh), pushes the branch, and prints ready-to-copy MR creation commands for both GitHub (`gh`) and GitLab (`glab`). Never runs `gh` or `glab` itself. Usage `/p-flow:task-end`.
argument-hint: (no arguments)
allowed-tools: Bash(git status:*) Bash(git rev-parse:*) Bash(git log:*) Bash(git diff:*) Bash(git push:*) Bash(git branch:*) Bash(test:*) Read Glob
---

# /p-flow:task-end

Finalize the task: verify discipline, push the branch, recommend an MR.

## Pre-checks

1. **Not on a protected branch.** Run `git rev-parse --abbrev-ref HEAD`. If output is `main`, `master`, or `develop` — refuse: *"You're on a protected branch. `/p-flow:task-end` only finalizes feature branches."*

2. **No uncommitted changes.** Run `git status --porcelain`. If non-empty:
   - Offer to commit the residue. Compose a draft Conventional Commits message from the diff (e.g. `fix(scope): adjust ...`). Show it to the user; on approval, commit.
   - If user declines — stop. Tell them to commit or stash first.

3. **Plan completeness (soft warning).** Read `specs/<slug>/plan.md` (resolve `<slug>` from the current branch by stripping `<type>/`). Count unchecked items (`- [ ]`) under sections `## Steps` and `## Review follow-ups — *`. **Do NOT count** items under `## Open questions`, `## Risks`, or `## Review decisions (audit)`. If any unchecked items remain — warn the user with the count and the section names, but allow them to continue.

4. **Verification marker freshness (soft warning).** Compute `<branch-safe>` (current branch with `/` → `__`). Check `.claude/.p-flow-state/<branch-safe>/last-verification`:
   - File missing → warn: *"No verification marker found. Have you run `verification-before-completion`?"*
   - File exists but is older than the latest commit (`git log -1 --format=%ct HEAD` vs. file mtime) → warn: *"Verification marker is older than the latest commit. Re-run `verification-before-completion`?"*

   In both cases, allow the user to continue.

## Push

5. **Determine push state.** Run `git rev-parse --abbrev-ref @{u}` (gets upstream). If the command fails — branch has no upstream; push with `-u`. If it succeeds and `git log @{u}..HEAD` is empty — already up to date, skip the push and tell the user.

6. **Push.** `git push -u origin <branch>` (or `git push` if upstream exists). Quote the push output.

## MR recommendation

7. **Compose title.** Use Conventional Commits format. Source: the first commit on this branch that touched real code (skip merge commits). Pattern: `<type>(<scope-from-commit-or-slug>): <subject>`.

   Run: `git log $(git merge-base main HEAD)..HEAD --format=%s --no-merges` (use `master` if no `main`). Pick the most representative subject, or compose a new one if the commits are too granular.

8. **Compose body.** Format:

   ```markdown
   ## Summary

   <one-paragraph distilled from `specification.md` Overview>

   ## What changed

   - <bullet per checked plan step's title>

   ## Test plan

   - <list of how to verify; pull from `verification-before-completion` marker content if present, else from `specification.md` Acceptance Criteria>
   ```

9. **Output recommendation.** Print to the user, in this exact shape:

   ```
   Branch pushed: <branch>

   Recommended MR title:
     <title>

   Recommended MR body:
   ─────────────────────────────────────────────
   <body>
   ─────────────────────────────────────────────

   Create the MR with whichever tool you use:

     # GitHub (requires `gh` CLI):
     gh pr create --title "<title>" --body "<body-escaped>"

     # GitLab (requires `glab` CLI):
     glab mr create --title "<title>" --description "<body-escaped>"

   Or open the host's web UI directly.
   ```

   For shell-safe escaping in the printed commands, wrap multi-line bodies via a heredoc reminder rather than inline. Example:

   ```bash
   gh pr create --title "<title>" --body "$(cat <<'EOF'
   <body>
   EOF
   )"
   ```

10. **(if `--worktree` was used on start) Worktree cleanup reminder.** Check `git worktree list` for a worktree on `<branch>`. If present — print:

    *"After this branch is merged, clean up with: `git worktree remove <worktree-path>`"*

    Do NOT remove the worktree.

## What this skill does NOT do

- Does not run `gh` or `glab` itself. The user picks the host.
- Does not merge, tag, or delete branches.
- Does not bump the plugin version (per the user's `no-proactive-releases` rule).
