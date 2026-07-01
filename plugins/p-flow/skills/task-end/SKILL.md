---
name: task-end
description: Exit point of the p-flow task development flow. Runs pre-checks (no main branch, no uncommitted changes, plan steps checked, verification marker fresh), pushes the branch, and prints ready-to-copy MR creation commands for both GitHub (`gh`) and GitLab (`glab`). Never runs `gh` or `glab` itself. Usage `/p-flow:task-end`.
argument-hint: (no arguments)
allowed-tools: Bash(git status:*) Bash(git rev-parse:*) Bash(git log:*) Bash(git diff:*) Bash(git push:*) Bash(git branch:*) Bash(git merge-base:*) Bash(git worktree:*) Bash(git remote:*) Bash(test:*) Bash(grep:*) Read Glob
---

# /p-flow:task-end

Finalize the task: verify discipline, push the branch, recommend an MR.

**Announce at start:** *"I'm using the `task-end` skill to push the branch and recommend an MR."*

## Design note

task-end deliberately offers no options menu (no "merge / open PR / cleanup / cancel" branching). The skill does push + MR-recommend, then stops. Rationale: `git merge` / `gh pr merge` / branch cleanup are user-driven decisions made outside the AI loop; offering a menu inside the skill conflates "what to recommend" (this skill's job) with "what to do next" (the user's call). If you find yourself wanting a menu here, use the host's web UI or `gh` / `glab` CLI directly — both produce a clearer audit trail than a chat-driven decision.

## Pre-checks

1. **Not on a protected branch.** Run `git rev-parse --abbrev-ref HEAD`. If output is `main`, `master`, or `develop` — refuse: *"You're on a protected branch. `/p-flow:task-end` only finalizes feature branches."*

2. **No uncommitted changes.** Run `git status --porcelain`. If non-empty:
   - Offer to commit the residue. Compose a draft Conventional Commits message from the diff (e.g. `fix(scope): adjust ...`). Show it to the user; on approval, commit.
   - If user declines — stop. Tell them to commit or stash first.

3. **Plan completeness (soft warning).** Resolve `<slug>`:
   - If the current branch matches `<type>/<slug>` for `<type>` ∈ {`feature`, `bugfix`, `hotfix`, `chore`, `docs`} → strip the prefix; the rest is `<slug>`.
   - Otherwise → ask the user for `<slug>` (with the current branch quoted as context). If the user can't supply one, **skip pre-checks 3 and 4** with a one-line warning (*"No `<slug>` resolved — skipping plan and verification-marker pre-checks."*) and proceed to Push.

   Then check completeness. Run the p-tasks gate in `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md`:
   - **Legacy mode (p-tasks absent):** read `specs/<slug>/plan.md`. If the file doesn't exist, warn (*"No plan at `specs/<slug>/plan.md` — skipping completeness check."*) and continue to pre-check 4. If it exists, count unchecked items (`- [ ]`) under sections `## Steps` and `## Review follow-ups — *`. **Do NOT count** items under `## Open questions`, `## Risks`, or `## Review decisions (audit)`.
   - **Canonical mode (p-tasks present):** there is **no `plan.md`** — do not read one. Via the Skill tool, `p-tasks:list <parent>` for the task titled `<slug>`, and count the sub-tasks whose `status` ≠ `done` (these are the open plan steps **and** open review-origin follow-ups — both live as sub-tasks).

   If any incomplete items remain (unchecked lines, or not-done sub-tasks) — warn the user with the count, but allow them to continue.

4. **Verification marker freshness (soft warning).** Compute `<branch-safe>` (current branch with `/` → `__`). Check `.claude/.p-flow-state/<branch-safe>/last-verification`:
   - File missing → warn: *"No verification marker found. Have you run `verification-before-completion`?"*
   - File exists but is older than the latest commit (`git log -1 --format=%ct HEAD` vs. file mtime) → warn: *"Verification marker is older than the latest commit. Re-run `verification-before-completion`?"*

   In both cases, allow the user to continue.

## Push

5. **Determine push state.** Run `git rev-parse --abbrev-ref @{u}` (gets upstream). If the command fails — branch has no upstream; push with `-u`. If it succeeds and `git log @{u}..HEAD` is empty — already up to date, skip the push and tell the user.

6. **Push.** `git push -u origin <branch>` (or `git push` if upstream exists). Quote the push output.

## MR recommendation

7. **Compose title.** Use Conventional Commits format.

   First resolve the **base branch**:
   - Default candidates in order: `main`, then `master`.
   - If neither exists locally → run `git remote show origin | grep 'HEAD branch'` to read the remote's default; use that.
   - If that also fails → ask the user for the base branch name.

   Then run: `git log $(git merge-base <base> HEAD)..HEAD --format=%s --no-merges`. Apply this **deterministic** rule:

   - **Exactly one** non-merge commit in the range → use that commit's subject verbatim.
   - **Two or more** non-merge commits → compose a squash subject as `<dominant-type>(<slug>): <one-line summary>`, where:
     - `<dominant-type>` = the most frequent Conventional Commits `type` among the subjects (ties → pick the highest-impact: `feat` > `fix` > `refactor` > `perf` > `chore` > `docs` > `test` > `style` > `build` > `ci` > `revert`).
     - `<slug>` = the slug resolved in pre-check 3 (omit the `(<slug>)` scope if no slug was resolved).
     - `<one-line summary>` = the first sentence of the `## Overview` (or `## Problem Statement`) section of `specs/<slug>/specification.md`. If no spec exists, summarize the diff in one short imperative sentence.

8. **Compose body.** Format:

   ```markdown
   ## Summary

   <one-paragraph distilled from `specification.md` Overview>

   ## What changed

   - <bullet per completed step title — legacy: each checked `## Steps` item; canonical: each done sub-task of `<slug>` via the Skill tool `p-tasks:summary <parent>`, which returns done items only>

   ## Test plan

   - <list of how to verify; pull from `verification-before-completion` marker content if present, else from `specification.md` Acceptance Criteria>
   ```

9. **Output recommendation.** Print to the user, **substituting** the markers `{{BRANCH}}`, `{{TITLE}}`, and `{{BODY}}` with the actual values you computed in steps 6–8. Do NOT print the markers literally.

   Template:

   ```
   Branch pushed: {{BRANCH}}

   Recommended MR title:
     {{TITLE}}

   Recommended MR body:
   ─────────────────────────────────────────────
   {{BODY}}
   ─────────────────────────────────────────────

   Create the MR with whichever tool you use. Use a heredoc for the body so newlines and special characters survive the shell:

     # GitHub (requires `gh` CLI):
     gh pr create --title "{{TITLE}}" --body "$(cat <<'EOF'
   {{BODY}}
   EOF
   )"

     # GitLab (requires `glab` CLI):
     glab mr create --title "{{TITLE}}" --description "$(cat <<'EOF'
   {{BODY}}
   EOF
   )"

   Or open the host's web UI directly.
   ```

10. **(if `--worktree` was used on start) Worktree cleanup reminder.** Check `git worktree list` for a worktree on `<branch>`. If present — print:

    *"After this branch is merged, clean up with: `git worktree remove <worktree-path>`"*

    Substitute `<worktree-path>` with the actual path for `<branch>` read from the `git worktree list` output — do NOT print the literal placeholder. Do NOT remove the worktree.

11. **(optional) Offer to close the p-tasks task.** Run the gate in `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md`. If p-tasks is **not** active, skip silently. If active **and** a `<slug>` was resolved in pre-check 3, offer:

    *"Mark the `<slug>` task and its sub-tasks done in p-tasks?"* (Add the Jira warning from the bridge doc if the destination is `jira`.)

    On an explicit **yes**: via the Skill tool, mark the task whose title is exactly `<slug>` `--status done`, **and** mark each of its still-open sub-tasks `--status done` too. p-tasks has **no status cascade** (parent and sub-task statuses are independent), so closing only the parent would leave its sub-tasks dangling `todo`/`in_progress`. Enumerate every sub-task with `p-tasks:list <parent>` (it returns all of them, in order, with status — unlike `p-tasks:summary`, which returns only **done** items), then `p-tasks:set <st-id> --status done` for each one whose `status` ≠ `done`.

    On **no**, or if no `<slug>` was resolved: skip. This step never blocks the push or the MR recommendation — those have already happened.

12. **(optional) Offer to capture decisions into p-wiki.** Run the gate in `${CLAUDE_SKILL_DIR}/../_shared/pwiki-bridge.md` (write side). If p-wiki is **not** active, skip silently. If active **and** a `<slug>` was resolved in pre-check 3, offer to compile the task's durable decisions into the wiki:

    *"Capture this task's decisions into the wiki? I'll compile the task's ADR/spec (`specs/<slug>/adr.md` if present, else `specification.md`) into wiki pages."* (Add the Confluence warning from the bridge doc if the destination is `confluence`.)

    On an explicit **yes**: via the Skill tool, invoke `p-wiki:compile` once per chosen source file (prefer `specs/<slug>/adr.md`; fall back to `specs/<slug>/specification.md`; **never** `plan.md`). Use `compile`, **not** `ingest` — the spec files are in-repo, and `ingest` refuses in-repo paths. `compile` is idempotent, so re-running updates the derived pages rather than duplicating them. Report how many pages were created/updated.

    On **no**, or if no `<slug>` was resolved: skip. Like step 11, this never blocks the push or the MR recommendation. When both step 11 and step 12 fire, offer p-tasks first, then p-wiki — they are independent.

## What this skill does NOT do

- Does not run `gh` or `glab` itself. The user picks the host.
- Does not merge, tag, or delete branches.
- Does not bump the plugin version (per the user's `no-proactive-releases` rule).
- Does not create or mutate p-tasks items silently — only offers (gated on p-tasks being present), and only with an explicit user yes. See `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md`.
- Does not write to p-wiki silently — only offers (gated on p-wiki being present), and only with an explicit user yes. See `${CLAUDE_SKILL_DIR}/../_shared/pwiki-bridge.md`.
