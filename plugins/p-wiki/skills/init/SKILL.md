---
name: init
description: |
  Initialize a markdown knowledge wiki at `docs/wiki/` of the current git repo and a global rule at `.claude/rules/p-wiki.md`. Use when the user says "init wiki", "create wiki", "setup knowledge base", or asks to start a new p-wiki.
argument-hint: (no arguments)
allowed-tools: Bash(git rev-parse:*) Bash(mkdir:*) Bash(node:*) Read Write
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
   - Structural pages (the Concepts/People/Sources/Queries containers and the Index) get a per-wiki title prefix so several wikis can share one space — Confluence Cloud requires page titles to be unique space-wide. The prefix defaults to the parent page's title (e.g. `Technical Specifications — Concepts`) and is persisted into `.pwiki.json` as `titlePrefix`. Pass `--title-prefix="<text>"` to override it. Content page titles are never prefixed.
   - On `error.code = config-invalid`, show the suggested fix and prompt again.
6. Continue with the rest of the scaffold (CLAUDE.md template, `.claude/rules/p-wiki.md`).

If the user picks `fs` (or the default), proceed with the existing FS scaffold path below.

## Step 2 — Add a mirror? (optional)

Ask the user (single question):

> Want to add a mirror? The mirror gets a 1:1 copy of the wiki on every `pwiki sync`. Useful for:
> - **Confluence primary + FS mirror** — git-backed backup of a Confluence wiki, browsable in IDE.
> - **FS primary + Confluence mirror** — markdown is canonical, Confluence is the published view.
>
> Pick: `none` (default), `fs`, or `confluence`.

If the user picks `none`, continue without a mirror — the wiki will run on the chosen primary only.

If the user picks `fs` and the primary is Confluence:
- Re-run the Confluence init with the `--mirror-fs` flag:
  `node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" init --confluence --site=<...> --space=<...> --parent=<...> --mirror-fs`

If the user picks `confluence` and the primary is FS:
- Prompt for mirror Confluence site URL, space key, and parent (same prompts as the Confluence-primary branch).
- After the FS scaffold completes, add a Confluence mirror by re-running init with:
  `node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" init --mirror-confluence --mirror-site=<...> --mirror-space=<...> --mirror-parent=<...>`
  (FS-primary init creates `.pwiki.json` with `primary: "fs", mirrors: ["confluence-mirror"]`; the mirror flags persist into `destinations`. The mirror's structural pages are prefixed from the mirror parent's title; override with `--mirror-title-prefix="<text>"`.)

After mirror setup, regardless of branch, continue with the FS-side scaffold step (CLAUDE.md template, `.claude/rules/p-wiki.md`).

## Step 3 — Find the repo root

Run `git rev-parse --show-toplevel` via Bash. If it fails (not a git repo), ask the user once whether to use the current working directory as the root. If they decline, stop. If they accept, use CWD.

Hereafter `<root>` = the resolved repo root.

## Step 4 — Already initialised? Offer sources instead of refusing

If `<root>/docs/wiki/` exists, the scaffold is done and must not be rewritten. Do **not** stop outright — say:

> Wiki already initialised at `<root>/docs/wiki/`. Nothing to scaffold — remove the directory by hand if you want a full reset.

Then ask whether they want to connect other wikis as read-only sources. If yes, jump straight to **Step 8** and skip Steps 5–7 (layout, content files, and the rule are already in place). If no, stop here.

This is the only way an existing wiki reaches Step 8: re-running `/p-wiki:init` is how sources get added later, not just at creation time.

## Step 5 — Create the layout

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

## Step 6 — Write the wiki content files

Read the templates from this skill's bundle and write them into the wiki:

| Read from | Write to |
|---|---|
| `${CLAUDE_SKILL_DIR}/../_shared/templates/wiki-claude-md.template.md` | `<root>/docs/wiki/CLAUDE.md` |
| `${CLAUDE_SKILL_DIR}/../_shared/templates/wiki-readme.template.md` | `<root>/docs/wiki/README.md` |
| `${CLAUDE_SKILL_DIR}/../_shared/templates/wiki-index.template.md` | `<root>/docs/wiki/index.md` |

Copy verbatim — no transformations.

## Step 7 — Write the global rule

Ensure `<root>/.claude/rules/` exists (`mkdir -p`). Then:

- If `<root>/.claude/rules/p-wiki.md` already exists, do NOT overwrite. Tell the user the file is present and they should review it before proceeding.
- Otherwise, copy `${CLAUDE_SKILL_DIR}/../_shared/templates/p-wiki-rule.template.md` to `<root>/.claude/rules/p-wiki.md` verbatim.

## Step 8 — Connect other wikis as read-only sources? (optional)

This step runs **after** the scaffold exists — the CLI needs `<root>/docs/wiki/` in place.

Ask the user (single question):

> Should this wiki read from other wikis? A read-only source is another p-wiki that `search` and `query` look into as well as this one — nothing is ever written back to it. Typical case: specs live in their own repo, this repo holds the code.
>
> Pick: `none` (default), or name the wikis to connect.

If the user picks `none`, skip to Step 9.

For each wiki they want to connect, ask two things — a short name (used as `--source=<name>` later) and where it lives — then run **one** command per source. Never hand-edit `.pwiki.json`; the CLI validates the block and probes the source before writing.

| Where the other wiki lives | Command |
|---|---|
| Its repo is cloned on this machine | `node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" source add <name> --kind=fs --path=<path to that repo root>` |
| Its `.pwiki.json` is readable on this machine (any backend, including Confluence) | `node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" source add <name> --from-config=<path to that .pwiki.json> [--from-destination=<block name>]` |
| GitHub, no clone | `node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" source add <name> --kind=github --owner=<org> --repo=<repo> [--ref=<branch>]` |
| GitLab, no clone | `node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" source add <name> --kind=gitlab --project=<group/repo> [--base-url=<host>] [--ref=<branch>]` |
| Hosted `index.json` over HTTP | `node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" source add <name> --kind=http --url=<url> [--auth-header=<header> --auth-token-env=<env var>]` |

Rules for this step:

- Prefer `--from-config` when the other wiki's config is reachable — it copies the whole block, which is the only practical way to add a **Confluence** source (that block carries space and page ids you should not retype).
- `github` / `gitlab` / `http` sources read a published `docs/wiki/index.json` bundle. If the source repo has never published one, tell the user to run `pwiki index` there and commit the file, otherwise the source stays empty.
- Private GitHub/GitLab repos need `PWIKI_GITHUB_TOKEN` / `PWIKI_GITLAB_TOKEN` in the environment. Never put a token in the config — the CLI rejects it.
- On `error.code = source-unreachable`, show the message and ask whether to correct the details or add it anyway with `--no-verify` (right choice when the token is only set on another machine).
- On `error.code = source-exists`, ask for a different name — the one given is already the primary, a mirror, or an existing source.

## Step 9 — Final message

Tell the user, in order:

1. Where the wiki was created (`<root>/docs/wiki/`).
2. That the global rule was created (or already existed) at `<root>/.claude/rules/p-wiki.md`.
3. Which read-only sources were connected, if any, and that search now covers this wiki first and those sources after it.
4. Suggest next steps:
   - For an external source: `/p-wiki:ingest <url-or-path>`.
   - For a doc already in the repo (spec, README, ADR, etc.): `/p-wiki:compile <path>`.
5. Remind them this is just a scaffold — they're free to commit it or not.

## Edge cases

- If `mkdir -p` fails (e.g. permission), stop and tell the user the exact error.
- If a template file can't be read (`${CLAUDE_SKILL_DIR}/../_shared/templates/X` missing), abort and tell the user the plugin install may be corrupted.
