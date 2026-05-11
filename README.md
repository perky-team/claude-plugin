# x-wiki

A Claude Code plugin that turns any git repo into an indexed markdown knowledge wiki under `docs/wiki/`. Skills: `init`, `ingest`, `compile`, `query`, `lint`.

## Install (local dev)

1. Clone this repo somewhere.
2. Add it to Claude Code as a plugin via `/plugin` (or whatever the current install command is — see `https://code.claude.com/docs/en/plugins`).
3. Open a project repo. Run `/x-wiki:init`.

## Commands

| Command | What it does |
|---|---|
| `/x-wiki:init` | Scaffolds `docs/wiki/` and a global rule at `.claude/rules/x-wiki.md`. |
| `/x-wiki:ingest <url\|path\|->` | Captures an external source (URL, outside-repo file, or inline paste) into `docs/wiki/raw/`. For files already in the repo, use `/x-wiki:compile <path>` directly. |
| `/x-wiki:compile [path]` | Synthesizes pages from a source file (raw/ or anywhere in the repo). Without an argument, processes all `raw/**` items with `compiled: false`. |
| `/x-wiki:query "<question>"` | Searches the wiki and writes a query-output page with citations. |
| `/x-wiki:lint` | Audits links, orphan pages, frontmatter, staleness. Reports only — does not auto-fix. |

## Design

See `docs/superpowers/specs/2026-05-11-x-wiki-plugin-design.md` in this repo.
