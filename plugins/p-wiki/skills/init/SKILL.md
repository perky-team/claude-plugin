---
name: init
description: |
  Initialize a markdown knowledge wiki at `docs/wiki/` of the current git repo and a global rule at `.claude/rules/p-wiki.md`. Use when the user says "init wiki", "create wiki", "setup knowledge base", or asks to start a new p-wiki.
argument-hint: (no arguments)
allowed-tools: Bash(git rev-parse:*) Bash(mkdir:*) Bash(test:*) Read Write
---

# /p-wiki:init

You are scaffolding the `p-wiki` knowledge base inside the current repo.

## Step 1 — Find the repo root

Run `git rev-parse --show-toplevel` via Bash. If it fails (not a git repo), ask the user once whether to use the current working directory as the root. If they decline, stop. If they accept, use CWD.

Hereafter `<root>` = the resolved repo root.

## Step 2 — Refuse if already initialised

If `<root>/docs/wiki/` exists, stop and tell the user: "Wiki already initialised at `<root>/docs/wiki/`. Remove the directory by hand if you want to reset it."

## Step 3 — Create the layout

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

## Step 4 — Write the wiki content files

Read the templates from this skill's bundle and write them into the wiki:

| Read from | Write to |
|---|---|
| `${CLAUDE_SKILL_DIR}/../_shared/templates/wiki-claude-md.template.md` | `<root>/docs/wiki/CLAUDE.md` |
| `${CLAUDE_SKILL_DIR}/../_shared/templates/wiki-readme.template.md` | `<root>/docs/wiki/README.md` |
| `${CLAUDE_SKILL_DIR}/../_shared/templates/wiki-index.template.md` | `<root>/docs/wiki/index.md` |

Copy verbatim — no transformations.

## Step 5 — Write the global rule

Ensure `<root>/.claude/rules/` exists (`mkdir -p`). Then:

- If `<root>/.claude/rules/p-wiki.md` already exists, do NOT overwrite. Tell the user the file is present and they should review it before proceeding.
- Otherwise, copy `${CLAUDE_SKILL_DIR}/../_shared/templates/p-wiki-rule.template.md` to `<root>/.claude/rules/p-wiki.md` verbatim.

## Step 6 — Final message

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
