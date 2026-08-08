# Project rules

## Implementing on Windows: EVERY test run happens under WSL

**If the host system is Windows, run the tests under WSL. Always, and the whole suite — not
only e2e, not only the files you touched.** A Windows run is optional extra information; the
WSL run is the one that decides whether the work is verified. Never report work as verified
on the strength of a Windows-only run.

**If WSL is missing something the run needs — a new enough node, a dependency, the repo copy
— install it there and continue.** A missing tool in WSL is a setup step, never a reason to
fall back to Windows-only and never a reason to stop and ask. The setup notes below make this
a few minutes once and instant afterwards.

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

So: when the implementation was done on Windows, the full suite under WSL is what verifies
it. Report BOTH platforms' numbers when you ran both, and say plainly which one is the WSL
run.

    wsl -e bash -lc 'export PATH=$HOME/.local/node24/bin:$PATH && cd ~/pshed && npx vitest run'

Setup notes that make this cheap and non-invasive (the first run takes a few minutes,
after that it is instant):

- **Do not reuse the Windows `node_modules`.** It holds platform-specific binaries
  (esbuild), and running `npm install` over the shared `/mnt/c` checkout would replace
  them and break the Windows side. Copy the repo into the WSL filesystem instead —
  `tar --exclude=./node_modules --exclude=./.git -cf - . | (cd ~/pshed && tar -xf -)` —
  and `npm install` there.
- **WSL's system node may be far too old** (Ubuntu 22.04 ships v12; vitest needs 18+, and
  this suite needs 24+ — see the next section). If `~/.local/node24` is not there, install
  it; do not run the suite on whatever node happens to be on PATH. Unpack a portable node
  rather than touching the system or requiring sudo:
  `mkdir -p ~/.local/node24 && curl -fsSL https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz | tar -xJ -C ~/.local/node24 --strip-components=1`
  then put it first on PATH for the run: `export PATH=$HOME/.local/node24/bin:$PATH`.
- To tell a real regression from a pre-existing failure, run the same test file against
  the merge-base: `git archive <merge-base> --format=tar` into a second WSL directory and
  reuse the same `node_modules`.

## Run the suite on Node 24+, on BOTH platforms

**Node 22 gives a false failure that looks like a p-graph bug and is not.** Measured, not
assumed: `node:sqlite` on v22.13.1 does not honor the `file:…?immutable=1` URI — the open
throws `unable to open database file` — while v24.19.0 does. p-graph's read-only store
falls back to a plain read-only open when the URI is rejected, and that fallback still
needs to create a `-shm` file, so `store-readonly.test.ts` ("answers a query correctly when
.pgraph is a read-only directory") fails on Node 22 on **both** Windows and Linux. The test
is right and the code is right; only the runtime is wrong. There is no third way — reading
WAL data without writing anywhere at all is exactly what `immutable=1` is for.

Node 22 also makes the suite roughly twice as slow (137 s vs 64 s under WSL), which pushes
spawn-heavy e2e files (`p-shed/cli-deploy-e2e`, `p-graph/cli-autorefresh`) over their
timeouts under full-run CPU contention — failures that vanish when the file is run alone.
Chasing those wastes a lot of time.

Note the asymmetry: this floor is for the **test suite**, not for the shipped plugins.
p-graph's own stated runtime floor is Node 22.5, and on Node 22 it degrades honestly — only
the read-only-directory case is unavailable.
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
