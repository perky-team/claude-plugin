# Project rules

## Release tagging on git push

When the user asks to push changes that alter plugin behavior or content (anything beyond explicit WIP/draft branches), pair the push with a semver release tag. Procedure:

1. List what's in the release: `git log <last-tag>..HEAD --oneline` (or `git log --oneline` if no tags exist yet).
2. Read the commits and pick the smallest bump that covers all of them:
   - **patch** (`vX.Y.Z+1`) — bug fix, refactor without behavior change, tests, docs, CI tweaks.
   - **minor** (`vX.Y+1.0`) — new skill, new template, new slash command, additive optional frontmatter field — any backwards-compatible extension.
   - **major** (`vX+1.0.0`) — removed or renamed skill / slash command, breaking change to frontmatter schema or template paths, breaking changes to `plugin.json` / `marketplace.json`.
3. Bump `plugins/p-wiki/.claude-plugin/plugin.json#version` to the chosen version and commit that bump as part of the same push (one push, one tag).
4. State the proposed version and the reasoning to the user (e.g. "minor — adds skill `/p-wiki:lint`, nothing removed") and wait for explicit confirmation. Never tag silently — public/irreversible actions require an explicit yes.
5. After confirmation: `git tag vX.Y.Z`, `git push`, `git push --tags`.

If there are no tags yet, the first tag is `v` followed by whatever `plugin.json` currently has as `version` (`v0.1.0` at the moment).
