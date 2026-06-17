# Plan: `p-wiki:sync` skill

**Design:** `docs/superpowers/specs/2026-06-17-pwiki-sync-skill-design.md`
**Date:** 2026-06-17

A thin slash-command wrapper over the existing, tested `pwiki sync` CLI. No sync logic
in the skill. No new tests (no new executable code).

## Tasks

### 1. Write the skill — `plugins/p-wiki/skills/sync/SKILL.md`

Frontmatter (match `init` / `lint` style):
- `name: sync`
- `description:` triggers on "sync wiki", "publish wiki", "push to confluence",
  "синхронизировать зеркало", plus a one-line summary of one-way primary → mirrors.
- `argument-hint: (no arguments)`
- `allowed-tools: Bash(git rev-parse:*) Bash(test:*) Bash(node:*) Read`

Steps:
1. Find the wiki: `<root>` = `git rev-parse --show-toplevel`; confirm
   `<root>/docs/wiki/CLAUDE.md`. Else stop.
2. Read `<root>/docs/wiki/.pwiki.json` (Read tool). Absent or `mirrors` empty → "nothing
   to sync" message, stop without error.
3. Confluence creds: for `primary` + each `mirrors[]` whose `destinations[name].kind`
   is `confluence`, require `PWIKI_CONFLUENCE_EMAIL` + `PWIKI_CONFLUENCE_TOKEN`; else
   instructions + API-token link, stop.
4. Pre-run notice: name the mirrors + the three semantic facts (one-way, manual edits
   overwritten, mirror-only pages deleted). No blocking confirmation — run immediately.
5. Run `node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" sync --format=json`; parse and
   render per-mirror written / rewritten / deleted / warnings / elapsed; totals.
6. Error handling table (reuse `/p-wiki:lint`'s `error.code → message` mapping); remind
   sync is idempotent and re-runnable after partial failure.

All text in English.

### 2. README — `plugins/p-wiki/README.md`

- Add the `/p-wiki:sync` row to the commands table.
- Delete the "It's a CLI command, not a skill, so it isn't in the table above"
  sentence in the multi-destination section; keep the `pwiki sync` CLI mention as the
  equivalent shell form.
- Update the one-line skills list at the top (`Skills: init, ingest, compile, query,
  lint, reconcile`) to include `sync`.

### 3. v3 design §7 note — `…/specs/2026-05-18-pwiki-v3-multi-destination-sync-design.md`

Add a short "**Revisited 2026-06-17**" note in §7 pointing to the new spec: the skill
is now added.

### 4. Templates

- `skills/_shared/templates/p-wiki-rule.template.md`: add `/p-wiki:sync` to the
  "Maintenance commands" list.
- `skills/_shared/templates/wiki-claude-md.template.md`: mention `/p-wiki:sync` next to
  the `pwiki sync` CLI invocation in the multi-destination section.

### 5. Manifests

- `.claude-plugin/marketplace.json`: append `sync` to the p-wiki skills list in its
  `description`.
- `plugins/p-wiki/.claude-plugin/plugin.json`: append `sync` to the skills list in its
  `description`.

## Verification

- `claude plugin validate plugins/p-wiki` passes.
- Existing test suite still green (no code changed): `npm test` under `plugins/p-wiki`.
- Manual: `/p-wiki:sync` on FS-only wiki → "nothing to sync"; on a mirror-configured
  wiki → renders counters.

## Release note (at push time, not now)

New skill = backwards-compatible additive change → p-wiki minor bump 4.9.0 → 4.10.0;
monorepo tag bumps minor accordingly.
