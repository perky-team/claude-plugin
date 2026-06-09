# p-wiki

A Claude Code plugin that turns any git repo into an indexed markdown knowledge wiki under `docs/wiki/`. Skills: `init`, `ingest`, `compile`, `query`, `lint`, `reconcile`.

Distributed via the [`perky.team`](../../) marketplace (see the repo root for the marketplace catalog).

## Install

```text
/plugin marketplace add perky-team/claude-plugin
/plugin install p-wiki@perky.team
```

The marketplace.json sits at the repo root, not inside this plugin's folder — so the `add` URL points at the repo, not at this subdirectory.

From a non-GitHub git host:

```text
/plugin marketplace add https://gitlab.com/perky-team/claude-plugin.git
/plugin install p-wiki@perky.team
```

## Local development

Load this plugin standalone without going through the marketplace:

```bash
claude --plugin-dir C:/path/to/x/plugins/p-wiki
```

After edits, run `/reload-plugins` inside Claude Code to pick them up without restarting.

## Commands

| Command | What it does |
|---|---|
| `/p-wiki:init` | Scaffolds `docs/wiki/` and a global rule at `.claude/rules/p-wiki.md`. |
| `/p-wiki:ingest <url\|path\|->` | Captures an external source (URL, outside-repo file, or inline paste) into `docs/wiki/raw/`. For files already in the repo, use `/p-wiki:compile <path>` directly. |
| `/p-wiki:compile [path]` | Synthesizes pages from a source file (raw/ or anywhere in the repo). Without an argument, processes all `raw/**` items with `compiled: false`. |
| `/p-wiki:query "<question>"` | Searches the wiki and writes a query-output page with citations. |
| `/p-wiki:lint` | Audits links, orphan pages, frontmatter, staleness, unresolved conflicts, and source-divergence. Reports only — does not auto-fix. |
| `/p-wiki:reconcile [path]` | Resolves conflict callouts and stale pages: re-merges a derived page with its current sources and removes the superseded callout. Genuine conflicts are left flagged for a human. |

## Design

See [`docs/superpowers/specs/2026-05-11-p-wiki-plugin-design.md`](./docs/superpowers/specs/2026-05-11-p-wiki-plugin-design.md) and [`docs/superpowers/plans/2026-05-11-p-wiki-plugin.md`](./docs/superpowers/plans/2026-05-11-p-wiki-plugin.md).

## Validate

```bash
claude plugin validate .
```
