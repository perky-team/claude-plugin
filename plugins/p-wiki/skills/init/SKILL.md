---
name: init
description: |
  Initialize a markdown knowledge wiki at `docs/wiki/` of the current git repo and a global rule at `.claude/rules/p-wiki.md`. Use when the user says "init wiki", "create wiki", "setup knowledge base", or asks to start a new p-wiki.
argument-hint: (no arguments)
allowed-tools: Bash(git rev-parse:*) Bash(mkdir:*) Bash(test:*) Bash(node:*) Read Write
---

# /p-wiki:init

You are scaffolding the `p-wiki` knowledge base inside the current repo.

## Step 0 — Verify Node 18+ is available

Run `node --version` via Bash. If it fails or returns a major version <18, stop and tell the user: "p-wiki requires Node ≥ 18 in PATH for the bundled CLI. Install or update Node, then re-run /p-wiki:init." Do not proceed with scaffolding.

## Step 1 — Choose destination

Ask the user (single question):

> Where should this wiki live? Options:
> - `fs` — local filesystem under `docs/wiki/` (default).
> - `confluence` — Confluence Cloud space (requires PWIKI_CONFLUENCE_EMAIL + PWIKI_CONFLUENCE_TOKEN env vars).

If the user picks `confluence`:

1. Verify both env vars are set; if not, output instructions linking to https://id.atlassian.com/manage-profile/security/api-tokens and stop.
2. Prompt: site URL (e.g. `https://example.atlassian.net`).
3. Prompt: space key (e.g. `ENG`).
4. Prompt: parent page title or numeric ID under which wiki pages will live.
5. Call `node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" init --confluence --site=<url> --space=<key> --parent=<title-or-id>`.
   - The CLI resolves the space (GET /wiki/api/v2/spaces?keys=<key>), looks up the parent page, ensures sub-parents, and writes `docs/wiki/.pwiki.json`.
   - On `error.code = config-invalid`, show the suggested fix and prompt again.
6. Continue with the rest of the scaffold (CLAUDE.md template, `.claude/rules/p-wiki.md`).

If the user picks `fs` (or the default), proceed with the existing FS scaffold path below.

## Step 2 — Find the repo root

Run `git rev-parse --show-toplevel` via Bash. If it fails (not a git repo), ask the user once whether to use the current working directory as the root. If they decline, stop. If they accept, use CWD.

Hereafter `<root>` = the resolved repo root.

## Step 3 — Refuse if already initialised

If `<root>/docs/wiki/` exists, stop and tell the user: "Wiki already initialised at `<root>/docs/wiki/`. Remove the directory by hand if you want to reset it."

## Step 4 — Create the layout

Create these directories (use `mkdir -p` via Bash):

```
<root>/docs/wiki/
<root>/docs/wiki/raw/articles/
<root>/docs/wiki/raw/files/
<root>/docs/wiki/raw/pastes/
<root>/docs/wiki/pages/concept/
<root>/docs/wiki/pages/person/
<root>/docs/wiki/pages/source/
<root>/docs/wiki/pages/queries/
```

Put a `.gitkeep` file in each leaf directory (7 files) so git tracks empty dirs.

## Step 5 — Write the wiki content files

Read the templates from this skill's bundle and write them into the wiki:

| Read from | Write to |
|---|---|
| `${CLAUDE_SKILL_DIR}/../_shared/templates/wiki-claude-md.template.md` | `<root>/docs/wiki/CLAUDE.md` |
| `${CLAUDE_SKILL_DIR}/../_shared/templates/wiki-readme.template.md` | `<root>/docs/wiki/README.md` |
| `${CLAUDE_SKILL_DIR}/../_shared/templates/wiki-index.template.md` | `<root>/docs/wiki/index.md` |

Copy verbatim — no transformations.

## Step 6 — Write the global rule

Ensure `<root>/.claude/rules/` exists (`mkdir -p`). Then:

- If `<root>/.claude/rules/p-wiki.md` already exists, do NOT overwrite. Tell the user the file is present and they should review it before proceeding.
- Otherwise, copy `${CLAUDE_SKILL_DIR}/../_shared/templates/p-wiki-rule.template.md` to `<root>/.claude/rules/p-wiki.md` verbatim.

## Step 7 — Final message

Tell the user, in order:

1. Where the wiki was created (`<root>/docs/wiki/`).
2. That the global rule was created (or already existed) at `<root>/.claude/rules/p-wiki.md`.
3. Suggest next steps:
   - For an external source: `/p-wiki:ingest <url-or-path>`.
   - For a doc already in the repo (spec, README, ADR, etc.): `/p-wiki:compile <path>`.
4. Remind them this is just a scaffold — they're free to commit it or not.

## Edge cases

- If `mkdir -p` fails (e.g. permission), stop and tell the user the exact error.
- If a template file can't be read (`${CLAUDE_SKILL_DIR}/../_shared/templates/X` missing), abort and tell the user the plugin install may be corrupted.
