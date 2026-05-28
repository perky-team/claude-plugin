# Project rules

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
