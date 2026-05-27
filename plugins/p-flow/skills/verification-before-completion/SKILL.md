---
name: verification-before-completion
description: Use before claiming any task is done, fixed, ready, implemented, or before any commit. Runs detected tests/lints, quotes concrete output, and writes a state marker at `.claude/.p-flow-state/<branch>/last-verification` so `/p-flow:task-end` can detect that verification ran. Evidence before assertions, always.
allowed-tools: Bash Read Glob Grep Write Edit
---

# verification-before-completion

Before any claim of completion ("done", "fixed", "ready", "implemented", "should work", "ready for review"), or before any `git commit`, run real checks and **quote concrete output**. Never claim success from intuition.

## When to run

- Any assertion of completion in chat.
- Before any `git commit`.
- After each step when `executing-plan` ships (Wave 2).

## Procedure

1. **Detect the test command.** Look at the repo:
   - `package.json` `scripts.test` → `npm test`
   - `pyproject.toml` / `pytest.ini` → `pytest`
   - `Cargo.toml` → `cargo test`
   - `go.mod` → `go test ./...`
   - `Gemfile` → `bundle exec rspec` or `rake test`
   - Maven/Gradle/sbt/MSBuild/dotnet — use the canonical command for that build system.
   - If none detected — say so explicitly (step 5).

2. **Detect lint/format command** (optional but preferred):
   - `eslint` / `prettier` config → `npm run lint` if scripted, else skip.
   - `ruff` / `black` / `flake8` config → run them.
   - Skip silently if not configured.

3. **Run the commands.** Use the Bash tool. Capture exit code and the last ~20 lines of output.

4. **Quote the output** in your response. Format:

   ```
   $ <command>
   <last lines of output>
   exit code: <N>
   ```

5. **Special cases:**
   - No tests found → say literally: "This repo has no test suite I can detect. I cannot verify by running tests." **Do NOT write the success marker** — there is nothing to verify; skip steps 6 and 7. Stop.
   - Tests fail → say literally: "Verification failed." Do NOT claim done. List the failing tests. Suggest re-entering implementation or `systematic-debugging` (Wave 2). **Do NOT write the success marker.** Stop.
   - Tests pass + lint passes → proceed to step 6.
   - User-facing feature changed (UI, CLI, endpoint) → also actually exercise the feature once. Quote the result.

6. **Write the success marker.**

   Compute the current branch name: `git rev-parse --abbrev-ref HEAD`. Call it `<branch>`.

   Replace `/` in `<branch>` with `__` to keep it safe as a path segment (e.g. `feature/foo` → `feature__foo`).

   Path: `.claude/.p-flow-state/<branch-safe>/last-verification`

   Content (overwrite if exists):

   ```
   timestamp: <ISO 8601 UTC now>
   commands:
     - <test command, exit 0>
     - <lint command, exit 0> (if applicable)
   ```

7. **Update `.gitignore` once.** If `.gitignore` exists and does not contain a line matching `.claude/.p-flow-state/`, append:

   ```
   # p-flow session state
   .claude/.p-flow-state/
   ```

   If `.gitignore` does not exist — create it with just those two lines.

## Hard rules

- **Never fake success.** Never say "tests pass" without running them. Never paraphrase output.
- **Marker is written only when at least one verification command actually ran and returned exit code 0.** "No tests detected" and "tests failed" both leave the marker untouched. Marker presence means "last verification succeeded".
- **Never bypass** the deny-list in `.claude/settings.json`.

## What this skill does NOT do

- Does not write tests (that's part of implementation).
- Does not integrate with CI.
- Does not fix failing tests — it reports failure and stops.
