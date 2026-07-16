---
name: init
description: Scaffold p-shed in the current folder — create `.pshed/` (jobs, state, logs, run) and gitignore the volatile parts. Use when the user says "init p-shed", "set up the scheduler", or "start scheduling Claude runs here".
argument-hint: (no arguments)
allowed-tools: Bash(git rev-parse:*) Bash(node:*) Bash(mkdir:*) Bash(which:*) Bash(where:*) Read Write Edit
---

# /p-shed:init

Scaffold the `p-shed` scheduler in the current folder. One-shot.

## Step 0 — Verify Node 18+
Run `node --version`. If it fails or the major version is < 18, stop and tell the user to install/update Node.

## Step 1 — Refuse if already initialized
If `.pshed/` exists, stop and tell the user: "p-shed already initialized here. Edit `.pshed/jobs.yml` to change jobs, or remove `.pshed/` to reset." Do not proceed.

## Step 2 — Resolve the folder
Run `git rev-parse --show-toplevel` to find the repo root and use that as `<root>` — the p-shed home. This must match how the CLI resolves its root (it walks up from the current directory to the nearest `.git`), otherwise `.pshed/` could end up in a subdirectory the CLI never looks at. If the command fails (not a git repo), fall back to the current working directory as `<root>`. (Jobs run relative to their own `cwd`; this folder just holds the scheduler state.)

## Step 3 — Create the layout
Create `.pshed/`, `.pshed/state/`, `.pshed/logs/`, `.pshed/run/`.

Write `.pshed/jobs.yml` (tracked in git):
    version: 1
    defaults:
      cwd: "."
      timeoutSec: 900
      permissionMode: acceptEdits
      allowedTools: "Read,Write,Edit,Bash(git *)"
    jobs: []

`.pshed/state/` starts empty — each job gets its own `<id>.json` file the first
time it ticks (gitignored).

Resolve the binaries and write `.pshed/config.json` (gitignored). Resolve `claude`'s
absolute path (`which claude` on POSIX, `where claude` on Windows); if it cannot be
resolved, write `"claude"` and warn the user that `p-shed:start` needs `claude` on PATH.
    { "nodeBin": "<absolute node path or 'node'>", "claudeBin": "<absolute claude path or 'claude'>" }

## Step 4 — gitignore the volatile parts
Ensure these lines exist in `<folder>/.gitignore` (append if missing). Keep `jobs.yml` tracked.
    .pshed/config.json
    .pshed/state/
    .pshed/logs/
    .pshed/run/

## Step 5 — Report
Tell the user what was created and that the next steps are `/p-shed:job` to add a schedule and `/p-shed:start` to begin ticking. Note: no rule file is installed — put run instructions in each job's prompt.
