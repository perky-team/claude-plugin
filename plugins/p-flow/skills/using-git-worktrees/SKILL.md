---
name: using-git-worktrees
description: Use when starting work that benefits from isolation from the current checkout (parallel feature branches, long-running experiments, freeing the main checkout for unrelated work). Reference documentation for safe worktree creation, common pitfalls, and cleanup.
allowed-tools: Bash(git worktree:*) Bash(git rev-parse:*) Bash(git branch:*) Bash(test:*) Read
---

# using-git-worktrees

A worktree is a second checkout of the same repository at a different filesystem path. Useful when you want isolation (different branch + different files on disk) without losing your current checkout's state.

## When to use

- Long-running feature work where you also need to fix urgent bugs in the main checkout.
- Experiments you want to abandon cleanly (delete the worktree, no merge conflicts elsewhere).
- Parallel reviews — one worktree per branch under review.

**Don't use when:**

- The branch you'd create the worktree for already has its checkout active somewhere — `git worktree add` will refuse.
- Disk space is tight — each worktree is a full file tree, not just a delta.

## Procedure

### Creating a worktree

1. Pick a path **outside** the current repo's directory tree. Convention — sibling dir named `<repo>-<branch-slug>` (e.g. `myrepo-feature-foo` next to `myrepo/`).
2. Run: `git worktree add <path> <branch>` — creates the path AND checks out `<branch>` there. If the branch doesn't exist yet — `git worktree add -b <new-branch> <path> <base-ref>`.
3. Open a new terminal / Claude Code session targeting `<path>`. The original checkout stays where it was on its original branch.

### Common pitfalls

- **Windows path length (260 chars).** Long worktree paths can hit Windows' `MAX_PATH` limit. Mitigation — `git config --global core.longpaths true` and use short branch slugs.
- **CWD doesn't follow.** A worktree is a different filesystem location. Your current session's CWD stays where it was; `cd` into the worktree (or open a new session) to actually work there.
- **Don't delete worktree dirs with `rm -rf`.** Use `git worktree remove <path>` so git's worktree registry stays consistent. Force-delete (`rm -rf`) leaves stale entries that `git worktree list` shows; `git worktree prune` cleans them up.
- **Submodules.** `git worktree add` doesn't auto-init submodules in the new tree. Run `git submodule update --init --recursive` in the new worktree if needed.

### Cleanup

- Done with the branch? `git worktree remove <path>` (refuses if the worktree has uncommitted changes; use `--force` consciously).
- Branch merged? You can delete the branch from any checkout — `git branch -d <branch>`. The worktree's HEAD points at the now-deleted branch — remove the worktree first.

## Hard rules

- **Never `git worktree add` onto a path that already exists** — git refuses, but the error is opaque. Check `test -e <path>` first.
- **Never share a worktree's branch with another worktree.** Two worktrees on the same branch is forbidden; git refuses.
- **Never commit hooks that assume the working tree is the only one.** Hooks run in whichever worktree triggers them; they shouldn't reach across.

## Red flags — STOP

- "I'll just `rm -rf` the worktree dir when I'm done" — no, use `git worktree remove`.
- "Two worktrees on the same branch is fine if they don't conflict" — git won't let you. Don't fight it.
- "I'll skip the path-length warning on Windows; it'll probably fit" — `core.longpaths true` is cheap insurance.

## What this skill does NOT do

- Does not create worktrees for you — you (or the calling skill, e.g. `/p-flow:task-start --worktree`) run `git worktree add`.
- Does not manage worktree-specific config (per-worktree gitconfig, sparse-checkout, etc.) — out of scope; consult `git-worktree(1)`.
- Does not handle `git-svn` or non-git VCS worktree equivalents.
