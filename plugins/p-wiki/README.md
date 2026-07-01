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

#### Git and HTTP read-only sources

Three additional source kinds let you pull pages from a remote wiki without cloning the repo: `gitlab`, `github`, and `http`. These kinds are **source-only** — they are rejected if listed as `primary` or in `mirrors`.

Each kind reads a single pre-built JSON bundle (`docs/wiki/index.json` by default) that the remote repo publishes. The consumer fetches this file on every `search` or `get --source=<name>` call; there is no local clone or cache.

**`gitlab`**

```json
{
  "kind": "gitlab",
  "project": "group/my-wiki-repo",
  "baseUrl": "https://gitlab.com",
  "ref": "main",
  "indexPath": "docs/wiki/index.json"
}
```

Fields: `project` (required, `group/repo` form); `baseUrl` (default `https://gitlab.com`); `ref` (default `main`); `indexPath` (default `docs/wiki/index.json`). Set `PWIKI_GITLAB_TOKEN` in env for private repos (never put the token in config).

**`github`**

```json
{
  "kind": "github",
  "owner": "my-org",
  "repo": "my-wiki-repo",
  "ref": "main",
  "indexPath": "docs/wiki/index.json"
}
```

Fields: `owner` and `repo` (both required); `ref` (optional, defaults to the repo's default branch); `indexPath` (default `docs/wiki/index.json`); `apiBaseUrl` (default `https://api.github.com`, override for GitHub Enterprise). Set `PWIKI_GITHUB_TOKEN` in env for private repos.

**`http`**

```json
{
  "kind": "http",
  "url": "https://example.com/wiki/index.json",
  "authHeader": "Authorization",
  "authTokenEnv": "MY_WIKI_TOKEN"
}
```

Fields: `url` (required, must serve `index.json` as `application/json`); `authHeader` and `authTokenEnv` (both optional, but must be set together). The env var named by `authTokenEnv` holds the token value; the header named by `authHeader` carries it.

#### Publishing a bundle for consumption

Before another repo can read your wiki, publish the index bundle:

```bash
# From the wiki repo — regenerates index.md and writes docs/wiki/index.json
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" reindex
git add docs/wiki/index.json
git commit -m "chore: update wiki bundle"
git push
```

No `pwiki sync`, no Confluence required. Consumers on GitLab/GitHub fetch `index.json` through the provider's raw-file API; consumers using `http` fetch it directly from your hosted URL.

> **Committed-bundle churn:** every `reindex` changes `index.json`, producing a commit each time. If that noise bothers you, add `docs/wiki/index.json` to `.gitignore`, generate the file in CI (e.g. a pre-publish step), and publish it to GitLab/GitHub Pages or any static host — then point an `http` source at the Pages URL instead.

#### Shared wiki over git — quick recipe

1. In the **shared wiki repo**, run `pwiki reindex` and push `docs/wiki/index.json` to the default branch (or set up CI to generate and publish it).
2. In each **consumer repo**, add a source block to `docs/wiki/.pwiki.json`:

   ```json
   {
     "sources": ["shared"],
     "destinations": {
       "shared": {
         "kind": "gitlab",
         "project": "my-org/shared-wiki"
       }
     }
   }
   ```

3. `pwiki search "<question>"` and `/p-wiki:query` now union results from both wikis. `pwiki get <path> --source=shared` reads a page from the shared wiki directly.

Full details (frontmatter schemas, identity format, reversing direction) live in the generated `docs/wiki/CLAUDE.md`, which Claude auto-loads when working under `docs/wiki/`.

## Design

Design specs and implementation plans for this plugin live under [`docs/`](./docs/).

## Validate

```bash
claude plugin validate .
```
