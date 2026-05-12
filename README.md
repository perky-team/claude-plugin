# x-wiki

A Claude Code plugin that turns any git repo into an indexed markdown knowledge wiki under `docs/wiki/`. Skills: `init`, `ingest`, `compile`, `query`, `lint`.

## Install

This repository is both the plugin and its own marketplace. The marketplace name is `andrey-plugins`.

Once the repo is published at `<owner>/x-wiki` on GitHub, install with:

```text
/plugin marketplace add <owner>/x-wiki
/plugin install x-wiki@andrey-plugins
```

From a non-GitHub git host, pass the full URL instead:

```text
/plugin marketplace add https://gitlab.com/<owner>/x-wiki.git
/plugin install x-wiki@andrey-plugins
```

## Local development

Clone the repo and load it without installing:

```bash
claude --plugin-dir C:/path/to/x-wiki
```

After edits, run `/reload-plugins` inside Claude Code to pick them up without restarting.

## Commands

| Command | What it does |
|---|---|
| `/x-wiki:init` | Scaffolds `docs/wiki/` and a global rule at `.claude/rules/x-wiki.md`. |
| `/x-wiki:ingest <url\|path\|->` | Captures an external source (URL, outside-repo file, or inline paste) into `docs/wiki/raw/`. For files already in the repo, use `/x-wiki:compile <path>` directly. |
| `/x-wiki:compile [path]` | Synthesizes pages from a source file (raw/ or anywhere in the repo). Without an argument, processes all `raw/**` items with `compiled: false`. |
| `/x-wiki:query "<question>"` | Searches the wiki and writes a query-output page with citations. |
| `/x-wiki:lint` | Audits links, orphan pages, frontmatter, staleness. Reports only — does not auto-fix. |

## Design

See `docs/superpowers/specs/2026-05-11-x-wiki-plugin-design.md` and `docs/superpowers/plans/2026-05-11-x-wiki-plugin.md` in this repo.

## Validate

After cloning, validate the plugin and marketplace structure:

```bash
claude plugin validate .
```
