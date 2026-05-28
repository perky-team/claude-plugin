---
name: release
description: |
  Audit this repo's plugins, run the test suite, fix problems found, and cut a release with per-plugin version bumps and a monorepo tag. Use when the user says "release", "выпусти релиз", "проверь плагины и зарелизь", or asks to push plugin changes that need versioning.
allowed-tools: Bash Read Edit Write Glob Grep
---

# release

You are auditing this perky.team Claude plugins repo, fixing problems, and
cutting a release. Strictly follow the order below — never skip steps and
never tag without explicit user confirmation.

The release-tagging procedure itself is canonically defined in
`.claude/CLAUDE.md` ("Release tagging on git push"). This skill operationalises
it and adds the audit + auto-fix phase that runs first.

## Step 1 — Inventory

Run in parallel:
- `git status --porcelain` — see uncommitted state.
- `git log --oneline $(git describe --tags --abbrev=0)..HEAD` — commits since
  the last monorepo tag. If `git describe` fails (no tags), fall back to
  `git log --oneline`.
- `node -e "for (const p of require('fs').readdirSync('plugins')) console.log(p, require('./plugins/'+p+'/.claude-plugin/plugin.json').version)"` — current per-plugin versions.

State a one-line summary: "N commits since `vX.Y.Z`, plugins at: …". Do not
start fixing yet — Step 2 may surface issues that change what needs to ship.

## Step 2 — Audit (read-only)

Run these and collect failures without fixing:

1. **`npm run validate`** — runs `claude plugin validate` against the
   marketplace and each plugin's manifest. Catches malformed
   `marketplace.json` / `plugin.json` / `commands/*.md` frontmatter.
2. **`npm test`** — vitest suite covering:
   - `marketplace.test.ts` — marketplace ↔ plugin manifest consistency
   - `plugin-manifests.test.ts` — every `plugins/*/.claude-plugin/plugin.json`
   - `plugin-readme-coverage.test.ts` — README skill lists match disk
   - `skills.test.ts` / `templates.test.ts` — skill & template frontmatter
   - `review-template-refs.test.ts` — review templates reference real files
   - the e2e tests (`p-flow-*-e2e`, `p-statusline-*-e2e`)

If a test or validation command itself errors out (missing `claude` CLI,
Node version mismatch, etc.) — STOP, report the env problem to the user and
ask how to proceed. Do not attempt to "work around" missing tools.

Group results into:
- **blockers** — failing tests / validate failures.
- **warnings** — flaky / skipped tests, suspicious git state (e.g.
  untracked files inside `plugins/`).

If both lists are empty, jump to Step 4.

## Step 3 — Fix

For each blocker, in order:

1. Read the failing test/assertion to find the *expected* state, then fix the
   plugin file to match — not the test. The test suite is the spec.
   Exception: if the test itself is genuinely wrong (e.g. references a file
   that was intentionally removed and no equivalent exists), pause and
   confirm with the user before editing the test.
2. Common fix patterns this repo expects:
   - README skill list out of sync → update the README, not the directory.
   - `marketplace.json` description out of sync with a plugin → update
     `marketplace.json` (per project convention: marketplace description is
     derived from plugin behaviour).
   - Missing/malformed frontmatter field → fix the SKILL.md / template.
   - Stale cross-references in p-flow review templates → update the template
     to point at the real file.
3. Re-run only the targeted test file (`npx vitest run tests/<file>`) after
   each fix. Only re-run the full suite once everything individual passes.

After all fixes: re-run `npm run validate && npm test` clean before moving
on. If any fix changed plugin behaviour or content, that plugin needs a
version bump in Step 4 — note it.

## Step 4 — Decide per-plugin bumps

Apply the procedure from `.claude/CLAUDE.md` literally. For each plugin
under `plugins/<name>/`:

1. Find the commit where its `plugin.json#version` was last bumped:
   `git log --diff-filter=M --pretty=%H -- plugins/<name>/.claude-plugin/plugin.json | head -1`.
2. Check if any file under `plugins/<name>/` changed since that commit, plus
   any pending fixes from Step 3:
   `git log --oneline <bump-sha>..HEAD -- plugins/<name>/`.
3. If no changes → no bump for this plugin.
4. Otherwise read those commits + working-tree diff and pick the smallest
   bump that covers everything:
   - **patch** — bug fix, refactor without behaviour change, tests, docs, CI.
   - **minor** — new skill / template / slash command / additive optional
     frontmatter field — any backwards-compatible extension.
   - **major** — removed or renamed skill / slash command, breaking change
     to frontmatter schema or template paths, breaking changes to
     `plugin.json` / `marketplace.json`.

## Step 5 — Decide the monorepo tag

- Take the highest bump level across all plugins affected in Step 4 and
  apply it to the previous monorepo tag (`git describe --tags --abbrev=0`).
- If there are no monorepo tags yet, the first tag is `v` followed by
  `plugins/p-wiki/.claude-plugin/plugin.json#version`.

## Step 6 — Announce the plan

State the full plan in one message, in this shape:

> Releasing `vA.B.C` — reasoning:
> - p-foo X.Y.Z → X.Y.(Z+1) (patch: <reason>)
> - p-bar A.B.C → A.(B+1).0 (minor: <reason>, <reason>)
> - p-baz: no changes since last bump
> Monorepo tag: highest bump = minor → `vA.B.C` → `vA.(B+1).0`.

This is an announcement, not a question — proceed straight to Step 7
without waiting for confirmation. The user invoked this skill explicitly
(`/release` or equivalent), so the go-ahead is already given.

This deliberately overrides the "wait for explicit confirmation" line
in `.claude/CLAUDE.md` — when the release skill is in use, the skill's
rules win.

## Step 7 — Execute

Run immediately after Step 6:

1. For each affected plugin: `Edit` its `plugin.json` to the new version.
   Read the file first.
2. Stage and commit all version bumps as ONE commit:
   `git add plugins/*/.claude-plugin/plugin.json` then commit with message
   shaped like the existing history (look at the last `chore(release):`
   commit via `git log --oneline | grep -i release | head -3` and mirror
   its style — usually
   `chore(release): vA.B.C — <plugin> <oldver>→<newver> <bump>, <plugin> …`).
   No `Co-Authored-By` / `Generated with Claude Code` lines — per global
   user rules in `~/.claude/CLAUDE.md`.
3. `git tag vA.B.C`
4. `git push` then `git push --tags` (two separate invocations — never
   `--follow-tags` or other shortcuts that silently bundle).
5. Run `git status` to confirm clean state and report:
   "Released `vA.B.C`. <N> plugin(s) bumped. Tag pushed."

If any step fails (push rejected, hook failure, etc.) — STOP, surface the
error, and ask before retrying. Never `--force` push and never `--no-verify`.

## Common mistakes

| Mistake | Fix |
|---|---|
| Tagging without bumping `plugin.json#version` for changed plugins | Marketplace cache is keyed on plugin version. Users won't get the new code. Always bump every affected plugin. |
| Bumping `plugin.json` without tagging the monorepo | The plugin version isn't what `claude plugin update` watches — the monorepo tag is. Both must happen. |
| Treating "no test failures" as "ready to ship" | Tests don't cover *intent*. If recent commits changed user-facing behaviour, still propose a minor bump. |
| Fixing the test instead of the plugin when they disagree | Tests are the spec. Edit the plugin. Only edit the test if the user confirms the test is wrong. |
| Running `npm test` once and assuming it's deterministic | E2e tests spawn processes; re-run on transient failures before declaring a blocker. |
| Tagging silently with no announcement | Step 6 announcement is still mandatory — the user must see the version line and reasoning before the push happens, even though no confirmation is required. |

## Red flags — STOP and reconsider

- About to `git push --force` anywhere → do not.
- About to tag without first announcing the version + reasoning in Step 6
  → do not. (Confirmation is NOT required, but visibility is.)
- A test failure that "looks unrelated" → it isn't. Read it. Fix it or
  surface it before tagging.
- `validate` warns about a manifest but you can't reproduce locally →
  ensure the `claude` CLI is on PATH and matches the user's installed
  version before assuming it's a false positive.
