# Project rules

## Implementing on Windows: e2e tests MUST also be run under WSL

A green Windows run does not mean the suite passes. These plugins are operated on Linux,
and a Windows-only run is green for two reasons that have nothing to do with the code
being correct. Both were measured in this repo, not assumed:

- **Tests guarded by `describe.skipIf(process.platform === 'win32')` never execute at
  all.** There is no CI here, so "skipped on Windows" means *verified nowhere*. In one
  case the only automated proof that a deploy releases its pause on SIGINT — the feature's
  core invariant, on the production platform — had never run anywhere until it was run
  under WSL.
- **Batch-file test stubs hide failures that a shell stub exposes.** A fake `claude`
  ending in `type … 2>nul` under `@echo off` leaves the batch status at 0, while the `sh`
  equivalent ending in `cat … 2>/dev/null` exits with *cat's* status. Four tests in
  `cli-concurrency-e2e.test.ts` were red on Linux — on `main`, not just on a feature
  branch — while passing on Windows. Timing differs too: a stub can win a race against
  `onSpawn` on Linux that it always loses on Windows.

So: when the implementation was done on Windows, run the e2e suites under WSL before
calling the work verified, and report BOTH platforms' numbers.

    wsl -e bash -lc '...'

Setup notes that make this cheap and non-invasive (the first run takes a few minutes,
after that it is instant):

- **Do not reuse the Windows `node_modules`.** It holds platform-specific binaries
  (esbuild), and running `npm install` over the shared `/mnt/c` checkout would replace
  them and break the Windows side. Copy the repo into the WSL filesystem instead —
  `tar --exclude=./node_modules --exclude=./.git -cf - . | (cd ~/pshed && tar -xf -)` —
  and `npm install` there.
- **WSL's system node may be far too old** (Ubuntu 22.04 ships v12; vitest needs 18+).
  Unpack a portable node into `~/.local/node` rather than touching the system or
  requiring sudo:
  `curl -fsSL https://nodejs.org/dist/v22.13.1/node-v22.13.1-linux-x64.tar.xz | tar -xJ -C ~/.local/node --strip-components=1`
- To tell a real regression from a pre-existing failure, run the same test file against
  the merge-base: `git archive <merge-base> --format=tar` into a second WSL directory and
  reuse the same `node_modules`.

## Release tagging on git push

When the user asks to push changes that alter plugin behavior or content (anything beyond explicit WIP/draft branches), pair the push with a semver release tag. Procedure:

1. List what's in the release: `git log <last-tag>..HEAD --oneline` (or `git log --oneline` if no tags exist yet).
2. Identify which plugins are affected: for each plugin under `plugins/<name>/`, check whether any of its files changed since its own `plugin.json#version` was last bumped (`git log <last-version-bump-commit>..HEAD -- plugins/<name>/`). A plugin with no file changes since its last bump does not get a new version.
3. For each affected plugin, read the commits touching it and pick the smallest bump that covers them:
   - **patch** (`vX.Y.Z+1`) — bug fix, refactor without behavior change, tests, docs, CI tweaks.
   - **minor** (`vX.Y+1.0`) — new skill, new template, new slash command, additive optional frontmatter field — any backwards-compatible extension.
   - **major** (`vX+1.0.0`) — removed or renamed skill / slash command, breaking change to frontmatter schema or template paths, breaking changes to `plugin.json` / `marketplace.json`.
4. Pick the monorepo tag: take the highest bump across all affected plugins and apply it to the previous monorepo tag (e.g. one plugin has a major, others minor → monorepo tag bumps major). Monorepo tags are global and shared across all plugins; per-plugin versions in `plugin.json#version` are independent and may diverge.
5. Bump `plugins/<name>/.claude-plugin/plugin.json#version` for each affected plugin to its chosen version, and commit all those bumps as part of the same push (one push, one monorepo tag). **A plugin's source files cannot ship in a release without its `plugin.json#version` also being bumped** — the marketplace cache is keyed on that version, so without a bump end users keep the old code.
6. State the proposed monorepo tag and per-plugin bumps with reasoning (e.g. "monorepo `v4.11.0` — p-statusline 0.1.0→1.0.0 major (renamed init→install), p-wiki 4.5.0→4.6.0 minor (new skill /p-wiki:lint)") and wait for explicit confirmation. Never tag silently — public/irreversible actions require an explicit yes.
7. After confirmation: `git tag vX.Y.Z`, `git push`, `git push --tags`.

If there are no monorepo tags yet, the first tag is `v` followed by whatever `plugins/p-wiki/.claude-plugin/plugin.json` currently has as `version` (`v0.1.0` at the moment).
