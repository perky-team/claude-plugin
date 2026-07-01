# p-wiki

A Claude Code plugin that turns any git repo into an indexed markdown knowledge wiki under `docs/wiki/`. Skills: `init`, `ingest`, `compile`, `query`, `lint`, `reconcile`, `sync`.

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
| `/p-wiki:sync` | Syncs the primary destination to every configured mirror (one-way primary → mirrors, idempotent). No-op when no mirrors are configured. |

## Storage backends

A wiki can be stored on the **filesystem** (default — `docs/wiki/`) or in **Confluence Cloud**. The choice is made at `/p-wiki:init` time and recorded in `docs/wiki/.pwiki.json`. Skills don't branch on the backend; the bundled CLI dispatches transparently, so `compile`, `query`, `lint`, etc. work the same either way.

Confluence mode needs two env vars:

- `PWIKI_CONFLUENCE_EMAIL` — your Atlassian account email.
- `PWIKI_CONFLUENCE_TOKEN` — an API token from <https://id.atlassian.com/manage-profile/security/api-tokens>.

Raw sources (`docs/wiki/raw/`) and any in-repo files referenced in `sources:` always stay on the filesystem in both modes.

### Multi-destination & `pwiki sync`

A wiki can have one **primary** destination (where every command writes) and zero or more **mirrors** that receive a 1:1 copy on every sync. Configured in `docs/wiki/.pwiki.json`:

```json
{
  "primary": "confluence",
  "mirrors": ["fs"],
  "destinations": {
    "confluence": { "kind": "confluence", "siteUrl": "...", "spaceKey": "...", "spaceId": "...", "rootPageId": "...", "titlePrefix": "...", "subParents": {} },
    "fs": { "kind": "fs" }
  }
}
```

The reverse topology is equally supported — FS as `primary` with a Confluence `mirror` (named `confluence-mirror`), where markdown is canonical and Confluence is the published view.

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" sync
```

`sync` walks the primary, writes every page into each mirror (translating cross-link targets to the mirror's format), deletes mirror-only pages (true-mirror semantics), and regenerates the Index on each mirror. Sync is **one-way** (primary → mirrors) with no conflict resolution — mirrors are overwritten. Run it from chat with `/p-wiki:sync` (a thin wrapper over this CLI command, listed in the table above), directly via the CLI, or from cron.

A wiki may also declare **read-only sources** — `"sources": ["other-wiki"]`, referencing `destinations` entries that p-wiki only *reads* (never writes). `search` and `query` union results from the primary plus every source (each result is tagged with its `source`; an unreachable source is reported in a `warnings` array rather than failing the search), and `pwiki get <path> --source=<name>` reads a page from a named source. Sources are p-wiki-formatted stores: a foreign Confluence space populated by another p-wiki (its block needs that space's `spaceId` / `rootPageId` / `subParents` — copy them from the source wiki's own `.pwiki.json`), or another on-disk wiki via an `fs` block with a `path`. All Confluence blocks share the same `PWIKI_CONFLUENCE_EMAIL` / `PWIKI_CONFLUENCE_TOKEN`, so a source on a different Atlassian account is not supported.

Full details (frontmatter schemas, identity format, reversing direction) live in the generated `docs/wiki/CLAUDE.md`, which Claude auto-loads when working under `docs/wiki/`.

## Design

Design specs and implementation plans for this plugin live under [`docs/`](./docs/).

## Validate

```bash
claude plugin validate .
```
