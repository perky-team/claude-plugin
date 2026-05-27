---
name: task-start
description: Entry point to the p-flow task development flow. Resolves slug + branch type + optional worktree, runs all conflict checks BEFORE any side effects, then atomically creates the branch (and worktree), opens `specs/<slug>/`, and invokes `task-brainstorming`. Usage `/p-flow:task-start <slug> [--worktree]`.
argument-hint: <slug> [--worktree]
allowed-tools: Bash(git rev-parse:*) Bash(git status:*) Bash(git branch:*) Bash(git checkout:*) Bash(git switch:*) Bash(git worktree:*) Bash(mkdir:*) Bash(test:*) Read Write
---

# /p-flow:task-start

Open a new task in the p-flow flow. Always read-only checks first, then atomic state changes.

## Arguments

- `<slug>` — kebab-case, lowercase, ≤ 50 chars. Required. If missing — ask the user.
- `--worktree` — optional flag. If present, the new branch is checked out in a fresh git worktree at `<repo-parent>/<repo-dir>-<slug>` instead of switching the current checkout.

## Phase A — read-only resolution (no side effects)

1. **Verify git repo.** Run `git rev-parse --show-toplevel`. If it fails — stop and tell the user: *"Not a git repo. Run `git init` first."*

2. **Verify clean working tree.** Run `git status --porcelain`. If output is non-empty — stop. Tell the user: *"Working tree is dirty. Commit or stash before starting a new task."*

3. **Ask for branch type.** Prompt the user with 5 options: `feature` / `bugfix` / `hotfix` / `chore` / `docs`. If a strong hint from prior conversation exists (e.g. the user said "fix a bug"), pre-select it but allow override.

4. **Compute targets:**
   - `<branch>` = `<type>/<slug>`
   - `<spec-dir>` = `specs/<slug>/`
   - `<worktree-path>` (only if `--worktree`) = the absolute path of the repo's parent directory, joined with `<basename-of-repo>-<slug>`. Use `git rev-parse --show-toplevel` to get the repo dir, then derive parent.

5. **Conflict scan (collect all, then resolve before mutating):**
   - Does `<branch>` already exist? `git branch --list <branch>` non-empty?
   - Does `<spec-dir>` exist and is non-empty? `test -d <spec-dir> && test -n "$(ls <spec-dir>)"`
   - If `--worktree`: does `<worktree-path>` already exist? `test -e <worktree-path>`
   - If `<worktree-path>` exceeds 200 chars on Windows — warn and recommend `git config --global core.longpaths true`.

   For any conflict — ask the user with a clear menu:

   - Branch exists → check out existing / pick different slug / cancel.
   - Spec dir exists and non-empty → continue editing existing / pick different slug / cancel.
   - Worktree path exists → pick different slug / cancel.

6. **Determine branch base:**
   - If on `main` or `master` — branch from there.
   - Otherwise — ask: branch from current HEAD / branch from `main` / cancel.

## Phase B — atomic side effects

Only after Phase A completes without `cancel`:

7. **Create the branch.** Run `git branch <branch> <base-ref>` then `git switch <branch>` (or skip `switch` if `--worktree` will check out elsewhere).

   If user chose "check out existing" in Phase A — instead run `git switch <branch>`.

8. **(if `--worktree`) Create the worktree.** Run `git worktree add <worktree-path> <branch>`. Print the path:

   *"Worktree created at `<worktree-path>`. Open a new terminal there to work on this task."*

9. **Ensure `specs/<slug>/` exists.** `mkdir -p specs/<slug>/`. If the user chose "continue editing existing" — leave its contents alone.

10. **Invoke `task-brainstorming` via the Skill tool.** Pass `<slug>` and `<type>` as initial context. Do not chain implicitly to any other skill — `task-brainstorming` itself decides when to invoke `writing-plan`.

## What this skill does NOT do

- Does not write any spec content (that's `task-brainstorming`).
- Does not push.
- Does not modify `main`/`master`.
- Does not delete branches or worktrees on conflict — only refuses, gives user options.
