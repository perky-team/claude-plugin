# Design: git/HTTP read-only source for p-wiki (published bundle)

**Date:** 2026-07-01
**Status:** Approved (brainstorming)
**Targets:** `plugins/p-wiki` 4.11.0 → 4.12.0 (minor — additive: new source kinds, a bundle format, a `reindex` command; no removals/renames)
**Related:** `2026-06-17-pwiki-external-readonly-source-design.md` (the `sources` machinery this builds on)

---

## 1. Goal

Let a p-wiki read a shared, project-wide p-wiki that lives in a **git host** (GitLab, GitHub, or any static HTTP host) as a **read-only source**, alongside its own local pages — with **no local clone/submodule**, no freshness management by the consumer, and no Confluence in the loop. `search` / `query` / `get` union the remote pages in exactly as they already union a Confluence source.

### 1.1 Pain addressed

In a microservice setup (many service repos, each with its own p-wiki), a shared project wiki holds cross-cutting specs/docs. Today the only remote-share option is Confluence: the shared wiki mirrors to a Confluence space via `pwiki sync`, and each service p-wiki adds that space as a source. The user wants a **simpler hub** — the shared wiki already lives in a git repo, so consumers should read it **directly from the git host over HTTP**, with `git push` as the only publish action (no `sync`, no Confluence account, no structural-ID setup).

### 1.2 Core design decision — a self-contained published bundle

The consumer reads **one file**: a generated `index.json` **bundle** that carries every page's frontmatter *and body*. This single choice removes the hard parts:

- **No host tree/listing API** — the page list is inside the bundle.
- **No per-page fetches** — bodies are inside the bundle.
- **No cache** — one live fetch per operation; always current.
- **Host-specific logic shrinks** to "build the URL of that one file + attach an auth header."

Search needs page bodies to rank; putting them in one file means one request instead of N. The consumer just fetches the URL and `JSON.parse`s it — zero new dependencies (consistent with p-wiki's no-deps stance, cf. vendored js-yaml).

### 1.3 Scope decisions (from brainstorming)

- **Topology:** identical to the existing Confluence source — a read-only source sits *alongside* the consumer's own wiki; `search`/`query`/`get` union primary + sources. Additive; nothing about `mirrors`/`sync`/Confluence changes.
- **Bundle-only transport.** The reader consumes the published `index.json` bundle. It does **not** call host tree/contents APIs and does **not** fetch pages individually.
- **Generic reader + thin host profiles.** One HTTP reader ("fetch a URL, attach an auth header, parse the bundle"); the `kind` selects a profile that builds the bundle URL + auth header from friendly config. Three kinds: `gitlab`, `github` (thin URL/auth builders) and `http` (escape hatch for Pages / S3 / nginx / any static host).
- **Source content is p-wiki-formatted** and lives at `docs/wiki/pages/**`. Reading arbitrary non-p-wiki content is out of scope (same constraint as the Confluence source).
- **Command scope:** only `query` / `search` / `get` honor sources (unchanged from the existing sources design). `reindex` is a new **primary-only** publish-side command.

### 1.4 Non-goals

- **Writing** to a git/HTTP source in any form (read-only).
- **Caching / conditional requests** (ETag / `If-None-Match`). v1 is always-live: one fetch per operation. A future optimization, noted in §7, not built now.
- **Per-page fetching or host tree/contents APIs.** The bundle is the whole contract.
- **Archive/tarball download** of the repo (would need tar/zip extraction — a dependency p-wiki avoids).
- **Auto-discovering a repo's default branch.** `ref` defaults to `main` for GitLab (its raw API requires a ref) or the repo's default branch for GitHub (its Contents API resolves that server-side when `ref` is omitted); always overridable in config.
- **`lint` / cross-link checking across the source boundary** (unchanged from the existing sources design).
- **Non-p-wiki content**, human-authored pages, arbitrary markdown.

---

## 2. The bundle format (`docs/wiki/index.json`)

A generated, committed artifact that sits beside the human-readable `index.md`.

```json
{
  "schema": 1,
  "generated": "2026-07-01",
  "wikiRoot": "docs/wiki",
  "pages": [
    {
      "type": "concept",
      "id": "rate-limiting",
      "path": "docs/wiki/pages/concept/rate-limiting.md",
      "frontmatter": { "title": "Rate limiting", "type": "concept", "tags": ["infra"], "updated": "2026-06-20" },
      "body": "# Rate limiting\n\n..."
    }
  ]
}
```

- Contains `pages/` only (the compiled pages), never `raw/` — mirrors what `sync` copies (`in: 'pages'`).
- `path` is repo-relative and matches the canonical layout `docs/wiki/pages/<dir>/<slug>.md`, so `type/slug` is recoverable from it (as the fs reader already does).
- `frontmatter` + `body` are exactly what `rankDocuments` and `get` need — so both are served from this one file.
- `schema` guards forward evolution; a reader that sees an unknown higher `schema` reports `bundle-invalid` rather than mis-reading.

**Trade-off (accepted):** the bundle duplicates page bodies (they exist in both the `.md` files and `index.json`), so it churns in git diffs on every edit. It's a text build-artifact and compresses well. Teams that dislike the churn may `gitignore` it and generate it in CI / publish to Pages instead (§8) — an option, not the default.

---

## 3. Publishing side — `reindex`

The bundle must be fresh at the moment of `git push`. Two mechanisms, together:

- **Piggyback existing regeneration.** Wherever the fs destination already regenerates `docs/wiki/index.md` (`regenerateIndex`), also write `docs/wiki/index.json`. Normal editing keeps the bundle current.
- **`pwiki reindex` command** — a thin, primary-only command that regenerates both `index.md` and `index.json` on demand. Intended to be wired to a **pre-push git hook** (or CI) so the bundle is guaranteed current at the publish boundary regardless of which command last touched pages.

Bundle construction lives in a new `tools/lib/bundle.mjs`: given a destination, enumerate `listPages({ in: 'pages' })`, read each body, and emit the bundle object. `reindex` writes it via the fs destination. **No network, no `sync`, no Confluence.** Publishing is: edit → (bundle regenerated) → `git push`.

---

## 4. Config schema

New destination `kind`s in `docs/wiki/.pwiki.json`, used from the `sources` array (never `primary`/`mirrors` — these kinds are read-only).

```json
{
  "primary": "fs",
  "mirrors": [],
  "sources": ["project-wiki"],
  "destinations": {
    "fs": { "kind": "fs" },

    "project-wiki": {
      "kind": "gitlab",
      "baseUrl": "https://gitlab.acme.com",
      "project": "platform/project-wiki",
      "ref": "main",
      "indexPath": "docs/wiki/index.json"
    }
  }
}
```

Per-kind blocks:

- **`gitlab`** — `project` (path `group/name` or numeric id, required), `baseUrl` (default `https://gitlab.com`), `ref` (default `main`), `indexPath` (default `docs/wiki/index.json`). Bundle URL: the **JSON file endpoint** (NOT `/raw`) `{baseUrl}/api/v4/projects/{urlEncoded(project)}/repository/files/{urlEncoded(indexPath)}?ref={ref}` — it responds `application/json` with `{ content, encoding: "base64" }`, which the shared transport parses; the reader base64-decodes `content`. Auth: `PRIVATE-TOKEN: $PWIKI_GITLAB_TOKEN` (omitted for public projects).
- **`github`** — `owner` + `repo` (required), `ref` (optional; GitHub Contents API defaults to the repo's default branch), `indexPath` (default `docs/wiki/index.json`), `apiBaseUrl` (default `https://api.github.com`, override for GitHub Enterprise). Bundle URL: Contents API `{apiBaseUrl}/repos/{owner}/{repo}/contents/{indexPath}?ref={ref}` — **default `application/json`** response with `{ content, encoding: "base64" }` (do NOT request the raw media type; the shared transport only surfaces a parsed body for `application/json`). Reader base64-decodes `content`. Auth: `Authorization: Bearer $PWIKI_GITHUB_TOKEN` (omitted for public repos).
- **`http`** — `url` (required, the full bundle URL), `authHeader` + `authTokenEnv` (both optional: header name + env var holding the token). Escape hatch for GitHub/GitLab Pages, S3, nginx, an internal static server. **The host must serve `index.json` with `Content-Type: application/json`** — the shared transport surfaces a parsed body only for that content-type (v1 constraint; see §6). Most hosts do this for `.json`.

### 4.1 Validation (`config.mjs`, `validateConfig`)

Extend the destination-block checks:

- `gitlab`: `project` is a non-empty string; `baseUrl`/`ref`/`indexPath` if present are non-empty strings.
- `github`: `owner` and `repo` are non-empty strings; `ref`/`indexPath`/`apiBaseUrl` if present are non-empty strings.
- `http`: `url` is a non-empty string; if `authHeader` is present then `authTokenEnv` must be too (and vice versa).
- These kinds may appear only in `sources` — a `gitlab`/`github`/`http` block named as `primary` or in `mirrors` is `config-invalid` (they implement no write contract). This mirrors the existing "roles are mutually exclusive" rule.
- Tokens are **never** read from config — only from the named env var. A block carrying an inline token is `config-invalid`.

No migration: absence of these kinds leaves every existing config valid.

---

## 5. Resolution (`destination.mjs`, `makeDestination`)

Add three branches alongside `fs` / `confluence`:

```
if (block.kind === 'gitlab' || block.kind === 'github' || block.kind === 'http')
  return createHttpBundleSource({ kind: block.kind, destinationConfig: block, transport: env.transport, env: process.env });
```

- Reuse the **injected `env.transport`** (the same seam the Confluence destination uses; `transport(req) → {status, headers, body}`, where `body` is the parsed JSON for `application/json` responses) so tests stub HTTP without real network.
- The reader calls `transport` **directly** — NOT `createHttpClient`, which hardcodes Confluence `Basic base64(email:token)` auth. It builds its own request `{ method: 'GET', url, headers }` with the profile's auth header, and — since `transport` resolves non-2xx **without throwing** — checks `res.status` itself and throws an error carrying `err.status = res.status` (exactly as the Confluence http client does), so the existing `mapErrorToCode` classifies it.
- The token is read from the env var named by the profile (`PWIKI_GITLAB_TOKEN` / `PWIKI_GITHUB_TOKEN` / the `http` block's `authTokenEnv`).
- Source construction stays **lazy** (existing `sources` Proxy) — a source is only built when actually read.

No change to `fs`/`confluence` construction. `resolveDestination`'s return shape is unchanged (sources already exist). **The only shared-code touch this feature needs** (outside the new reader + config/destination wiring) is a one-line addition to `mapErrorToCode`: `if (err?.code === 'bundle-invalid') return 'bundle-invalid';` — everything else reuses existing codes via `err.status`.

---

## 6. The reader (`destinations/http-bundle.mjs`)

One reader serving all three kinds; the only per-kind difference is the URL builder + auth header (a small profile table).

Implements the **source read contract** that `search`/`get` invoke:

- `fetchBundle()` — build the request via the profile and call `transport` directly. Check `res.status`: non-2xx → throw `err` with `err.status` set (→ `auth-failed`/`page-not-found`/`rate-limited`/`network-error` via `mapErrorToCode`). On 2xx, obtain the bundle text: for `github`/`gitlab`, `res.body` is `{ content, encoding: "base64" }` → `Buffer.from(content, 'base64').toString('utf-8')`; for `http`, `res.body` is the already-parsed bundle object. `JSON.parse` the text (skip if already an object) and validate `schema`; on non-JSON / unknown `schema` throw an error with `err.code = 'bundle-invalid'`. **No retry loop** (that lived in `createHttpClient`, which we bypass) — a 429 simply surfaces as `rate-limited`. Called once per process (search and get are separate subprocesses — §2.2 of the sources design).
- `search(query, opts)` — `fetchBundle()`, build `{ path, frontmatter, body }` docs from `pages`, apply `type`/`tags` filters, run the shared `rankDocuments` (identical ranking to the fs reader), return `{ total, results }`.
- `readPage(repoRelPath)` — `fetchBundle()`, find the page whose `path` matches, return `{ frontmatter, body, path }`. Not found → the same `page-not-found` shape the fs reader uses.
- `kind` — the block kind.

The reader needs only `search`, `readPage`, and `kind` — that is the entire contract `search`/`get` invoke on a source (verified in `pwiki.mjs`: the search union calls `dest.search`, `getPage` calls `dest.readPage`; neither calls `pathFor` on a source). It is **read-only**: no `writePage`/`deletePage`/`mutatePage`/`ensureStructure`/`regenerateIndex`/`pathFor` (a source is never a write target and needs no path derivation — pages carry their own `path`; and `directoryFor` already includes `pages/`, so deriving paths here would be wrong anyway).

No change to `search`/`get` union logic in `pwiki.mjs` — they already loop `sourceNames`, call `.search()`/`.readPage()`, tag results with `source`, and capture per-source failures in `warnings` (fatal only for `primary`). The new reader satisfies that contract, so it drops in.

---

## 7. Error handling & freshness

| code | when | search | get |
|---|---|---|---|
| `config-invalid` | bad block / inline token / wrong role | — | — |
| `page-not-found` | index.json 404 (wrong path/ref, repo moved) — **reused** code, from `err.status === 404` | warning, primary still answers | fatal (exit 1) |
| `bundle-invalid` | non-JSON / unknown `schema` — reader sets `err.code`; needs the one-line `mapErrorToCode` addition (§5) | warning | fatal |
| `auth-failed` / `rate-limited` / `network-error` | host rejects (401/403 / 429) / unreachable (5xx, ECONN*) — from `err.status`/`err.code` | warning | fatal |

Consistent with the existing sources design: a failing **source** never aborts a `search` (captured in `warnings[]`); a failing **primary** stays fatal. `get` against a broken source is fatal (the user explicitly asked for that page).

**Freshness:** always-live — every `search`/`get` fetches the bundle fresh, so consumers never manage staleness. **Future (non-goal now):** send `If-None-Match` with a stored ETag and skip re-download on `304`, and/or dedupe the two fetches within one `query`. Not built in v1.

---

## 8. Coexistence with Confluence / `sync`

Purely additive. `mirrors` (write, driven by `sync`) and `sources` (read) are independent lists of pluggable kinds:

- The **shared wiki repo** can mirror to Confluence (`sync`) **and** publish `index.json` (git push) at once — two audiences, one source of truth.
- A **service repo** lists whichever source(s) it wants in `sources` — a `confluence` source, a `gitlab`/`github`/`http` source, or several (results union). Per-repo choice, not global.

Nothing in this design removes or changes Confluence, `sync`, or the `mirrors` path. For teams that dislike the committed-bundle churn (§2), `gitignore index.json` + generate it in CI / publish to Pages, then point a `http` source at the Pages URL — same reader, no repo churn.

---

## 9. Citations (bonus)

Unlike the Confluence source (whose `confluence://type/slug` citations aren't clickable URLs), a git/HTTP source can derive a **clickable web URL** for each cited page from the profile (`github`/`gitlab` blob URL for the page's `path`@`ref`; for `http`, a configurable page-URL template or omit). `query` cites by title + URL. Small, additive; can land with the feature or as a follow-up.

---

## 10. Testing (TDD)

- **config** (`config.test.ts`): valid `gitlab`/`github`/`http` blocks; each required field missing → invalid; inline token → invalid; kind used as `primary`/mirror → invalid; absent → still valid.
- **resolveDestination** (`destination-resolve.test.ts`): the three kinds construct via the new factory, lazily, from the `sources` list.
- **reader** (`http-bundle.test.ts`, transport stubbed with a fixture bundle): `search` ranks identically to fs for the same content and tags results with the source; `readPage` returns the right page; `github`/`gitlab` bodies are base64-decoded, `http` bodies used as-is; a transport error → `search` surfaces a `warnings` entry while primary results survive; `get` against a broken source is fatal; a 404 → `page-not-found`; malformed JSON / unknown `schema` → `bundle-invalid`; the auth header is attached only when the env token is set; a non-2xx status is turned into an `err.status`-carrying throw; URL building is correct per kind (incl. self-hosted `baseUrl`/`apiBaseUrl` and URL-encoding of `project`/`indexPath`).
- **bundle generation** (`bundle.test.ts`): `reindex` produces a bundle whose `pages` match the primary's `pages/` set (frontmatter + body), excludes `raw/`, and round-trips (feed the generated bundle to the reader → same search/get results as reading the fs primary directly). Piggybacked regeneration writes `index.json` wherever `index.md` is written.
- **search union** (extend the existing sources union test): an `http`-kind source unions with the fs primary; per-source `--limit`; `warnings` on failure.

Use the injected `transport` seam (as `cli-get-confluence.test.ts` / `fake-confluence` do) — no real network in tests.

---

## 11. Documentation

- **README** "Multi-destination" / sources section: document the `gitlab`/`github`/`http` source kinds, the env tokens, the `indexPath`/`baseUrl`/`ref` fields, and that publishing is `reindex` (or the pre-push hook) + `git push` — no `sync`, no Confluence required. Note the committed-bundle churn and the Pages/`gitignore` alternative.
- **`skills/_shared/templates/wiki-claude-md.template.md`** CLI section: add `pwiki reindex`, the new source kinds, and that `get --source=<name>` works against them.
- A short "shared wiki over git" recipe: shared repo publishes `index.json`; service repos add a `gitlab`/`github`/`http` source.

---

## 12. Backwards compatibility & versioning

- Additive only: new optional destination kinds, a new `reindex` command, a new generated `index.json` artifact. No command renamed/removed; `sync`, `mirrors`, Confluence, `fs` unchanged.
- Configs without the new kinds behave exactly as before. `index.json` generation is new output beside `index.md`; a repo that never pushes it is simply not consumed over HTTP.
- Reader code for `fs`/`confluence` untouched.

**Version bump:** 4.11.0 → **4.12.0** (minor). Final monorepo tag fixed at push time per the repo's release rules.
