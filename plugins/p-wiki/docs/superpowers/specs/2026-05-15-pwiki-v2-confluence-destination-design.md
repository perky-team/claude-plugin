# Design: `pwiki` v2 — Confluence destination

**Date:** 2026-05-15
**Status:** Drafted (brainstorming)
**Targets:** `plugins/p-wiki` v2.0.0 (major bump from v1.x)
**Supersedes:** `2026-05-14-confluence-destination-sketch.md`

---

## 1. Goal

Add a second implementation of the `Destination` interface so the same `pwiki` CLI and the same skills can store the wiki in Confluence Cloud instead of the local filesystem. The choice is made at `init` time and recorded in `docs/wiki/.pwiki.json`; from there on every CLI command dispatches to the configured backend, and skills do not branch on destination.

### 1.1 Pains addressed

- Teams whose canonical knowledge base is Confluence today have to mirror anything pwiki produces by hand. v2 makes pwiki write directly to Confluence so the wiki lives where the team already reads it.
- The v1 architecture explicitly carved out a `Destination` interface seam for exactly this case (`2026-05-14-pwiki-cli-design.md` §2.6). v2 fills the seam.

### 1.2 Non-goals

- **Server / Data Center.** Cloud only. Storage format and REST v1 endpoints are out of scope.
- **Migration FS↔Confluence.** Deferred to v2.1. A user starting on Confluence starts with an empty wiki; FS users do not auto-import.
- **Round-trip user edits.** If a human edits a page in Confluence UI between two `pwiki` writes, the next write overwrites the human edit. Version history in Confluence preserves the old content; pwiki does not attempt detect-and-merge. Rule: pages under the configured root are managed by pwiki, edit via skills.
- **Raw sources in Confluence.** `raw-article`, `raw-file`, `raw-paste` keep living in `docs/wiki/raw/` on disk in both modes. The Confluence backend handles only the synthesized pages (concept, person, source, query).
- **Replacing FS backend.** v1 FS implementation is unchanged. v2 is purely additive.

---

## 2. Architecture

### 2.1 Layout inside the plugin

```
plugins/p-wiki/
├── tools/
│   ├── pwiki.mjs                    ← unchanged: dispatches through Destination
│   ├── lib/
│   │   ├── destination.mjs          ← resolver gains config-aware branch
│   │   ├── destinations/
│   │   │   ├── fs.mjs               ← unchanged
│   │   │   └── confluence.mjs       ← new
│   │   ├── confluence/              ← new submodule, used only by confluence.mjs
│   │   │   ├── http.mjs             ← node:https client + auth + retries
│   │   │   ├── adf.mjs              ← markdown → ADF + ADF → markdown (subset)
│   │   │   ├── identity.mjs         ← pwiki-id property ↔ numeric page id
│   │   │   ├── tree.mjs             ← sub-parents bootstrap & lookup
│   │   │   ├── search.mjs           ← CQL builder + result mapper
│   │   │   └── lint.mjs             ← Confluence-flavoured lint checks
│   │   ├── config.mjs               ← new: read/write docs/wiki/.pwiki.json
│   │   ├── paths.mjs                ← unchanged
│   │   ├── yaml.mjs                 ← unchanged
│   │   ├── fm.mjs                   ← unchanged
│   │   ├── schema.mjs               ← unchanged (frontmatter source of truth)
│   │   ├── slug.mjs                 ← unchanged
│   │   ├── search.mjs               ← unchanged (FS-only helpers)
│   │   ├── lint.mjs                 ← unchanged (FS-only helpers)
│   │   ├── backlinks.mjs            ← unchanged (FS-only pure logic)
│   │   ├── index.mjs                ← unchanged (FS-only pure logic)
│   │   └── md.mjs                   ← unchanged
│   └── __tests__/                   ← new tests added per layer; existing tests untouched
└── skills/                          ← unchanged: skills do not branch on destination
```

### 2.2 Dependencies

**Still zero npm dependencies.** Confluence backend uses Node ≥ 18 stdlib only:

- `node:https` for the HTTP client.
- `JSON.parse` / `JSON.stringify` for both ADF and Confluence REST payloads — no XHTML parser, no markdown library.
- Hand-rolled markdown↔ADF converter targets the narrow subset our skills actually generate (h1-h3, paragraphs, ordered/unordered/nested lists, inline marks for bold/italic/code/link, fenced code blocks, blockquotes for conflict callouts).

Rationale unchanged from v1 §2.2: plugins distribute as git checkouts, `npm install` is not part of `/plugin install`. Adding a markdown→ADF library (`@atlaskit/editor-markdown-transformer` ships React) is disproportionate to the subset we need.

### 2.3 Skill ↔ CLI contract

Unchanged from v1 §2.3. Skills call `node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" <command> [args] --format=json`. CLI output paths stay opaque to the skill — for Confluence they are `confluence://<type>/<slug>`. Exit codes 0/1/2/3 keep their meaning; v2 adds a structured `error.code` field inside the JSON body for failure classes that need user-actionable messages (§5.2).

**Two distinct URL shapes in Confluence mode** — do not confuse them:

- **Identity path** — `confluence://<type>/<slug>`. Used in CLI input/output, in `sources:`-style cross-references inside frontmatter, and as the key skills pass between commands. Opaque, stable across UI title renames.
- **Body link href** — real Confluence URL `<siteUrl>/wiki/spaces/<spaceKey>/pages/<numericId>`. Used inside ADF `link` marks for body cross-references (e.g. backlinks inserts these). Required by Confluence UI for the link to be clickable. Numeric id is stable across title renames; lint resolves it back to a `pwiki-id` to check liveness.

### 2.4 Wiki discovery

Unchanged from v1 §2.4. CLI walks up from `process.cwd()` until it finds `docs/wiki/CLAUDE.md`. The resolver then reads `docs/wiki/.pwiki.json` to pick the destination.

### 2.5 Schema source of truth

`tools/lib/schema.mjs` remains canonical for **both** backends. In Confluence, frontmatter is stored as page properties with a `pwiki-` prefix:

| Frontmatter field | Page property | Type encoding |
|---|---|---|
| `id` | `pwiki-id` | string (= slug) |
| `type` | `pwiki-type` | string (`concept` \| `person` \| `source` \| `query`) |
| `title` | `pwiki-title` | string |
| `created` | `pwiki-created` | ISO 8601 string |
| `updated` | `pwiki-updated` | ISO 8601 string |
| `status` | `pwiki-status` | string |
| `tags` | `pwiki-tags` + Confluence labels (dual-encoded) | JSON-string array; labels are first-class in CQL, see §3.7 |
| `sources` | `pwiki-sources` | JSON-string array |
| `source-url` | `pwiki-source-url` | string (source type only) |
| `source-type` | `pwiki-source-type` | string (source type only) |
| `question` | `pwiki-question` | string (query type only) |
| `informed-by` | `pwiki-informed-by` | JSON-string array (query type only) |

JSON-string encoding for arrays sidesteps Confluence property-shape quirks (some endpoints return arrays as comma-joined strings). On read, the destination collects all `pwiki-*` properties and reassembles a plain frontmatter object with the same shape `fm.mjs` produces on FS — downstream code does not see the difference.

**Tags dual encoding.** `tags` are written to **both** the `pwiki-tags` JSON-string property AND Confluence labels on the page. The JSON-string property is the canonical pwiki representation (round-trip safe, preserves order); labels are a denormalized search-index used by CQL (`labels = "X"`) and by humans browsing in the Confluence UI. `writePage` and `mutatePage` keep both in sync; on read, `pwiki-tags` is authoritative if they diverge (e.g. a user added a label in UI — lint surfaces this as drift in a future version, out of v2 scope).

**Sub-parent and Index marker.** The four sub-parent pages (Concepts, People, Sources, Queries) and the Index page each carry a single property `pwiki-role` with values `"sub-parent:concept" | "sub-parent:person" | "sub-parent:source" | "sub-parent:query" | "index"`. This lets lint cleanly exempt them from all wiki-content checks (drift, frontmatter, orphan-pages, underlinked) by filtering on `property["pwiki-role"] IS NOT EMPTY`. Sub-parents and Index are not wiki entries; they are pwiki-managed structural artifacts.

### 2.5.1 REST API version mix

- v2 endpoints (`/wiki/api/v2/...`) for **pages and page properties** — modern, stable, future-proof.
- v1 endpoint (`/wiki/rest/api/search`) for **CQL search** — v2 has no general CQL replacement; mandatory for search/lint/applyBacklinks lookups.
- Properties access in v2 is keyed by **numeric `propertyId`**, not by key string. The destination wraps this in a helper `properties.upsert(pageId, key, value)`:
  1. `GET /wiki/api/v2/pages/<pageId>/properties` → list of `{id, key, value, version}`.
  2. If key exists: `PUT /wiki/api/v2/pages/<pageId>/properties/<id>` with new value + `version.number = current + 1`.
  3. If key absent: `POST /wiki/api/v2/pages/<pageId>/properties` with `{key, value}`.

  The first list-fetch is cached per `pageId` for the lifetime of one CLI invocation, so a typical `writePage` does one list-fetch + N upserts (one per `pwiki-*` field).

### 2.6 Destination interface

Signatures unchanged from v1 §2.6 (extended in v1.1 with `applyBacklinks` and `regenerateIndex`). Semantic differences per method are in §3.

Resolver in v2:

```
resolveDestination({ cwd }):
  root = findWikiRoot(cwd)
  if root === null: return null
  config = readConfig(root)                            // tools/lib/config.mjs
  if config?.destination === "confluence":
    return createConfluenceDestination({ root, config })
  return createFsDestination({ rootPath: root })       // default
```

No config file ⇒ FS, preserving v1 behavior for every existing wiki.

---

## 3. Destination methods, semantics, data flow

### 3.1 `pageExists({ type, slug })`

- **FS:** unchanged — file stat at `pages/<type>/<slug>.md`.
- **Confluence:** CQL `ancestor = subParents[type] AND property["pwiki-id"] = "<slug>" AND property["pwiki-type"] = "<type>"`. Returns true iff exactly one match.

### 3.2 `readPage(path)`

- **FS:** unchanged — `fs.readFile` + `parseFrontmatter`.
- **Confluence:**
  1. `identity.resolveByPath(path)` → numeric page id (one CQL lookup; cached per CLI process by `(type, slug)`).
  2. `GET /wiki/api/v2/pages/<id>?body-format=atlas_doc_format` → ADF body + metadata.
  3. `GET /wiki/api/v2/pages/<id>/properties` → all `pwiki-*` properties.
  4. `adf.adfToMarkdown(body)` → markdown body string.
  5. Compose frontmatter object from properties (per §2.5 table).
  6. Return `{ frontmatter, body, path }`.

### 3.3 `writePage({ type, slug, frontmatter, body, onConflict })`

- **FS:** unchanged.
- **Confluence:**
  1. `pageExists({ type, slug })` — if true:
     - `onConflict = "fail"` → return `{ created: false, existingPath, dateSuffixSlug }`, exit 2 at CLI layer.
     - `onConflict = "date-suffix"` → set `slug = withDateSuffix(slug, today())`, re-run `pageExists` with the new slug; if still true, exit 2 (same single-suffix behavior as FS — we trust today's slug to be unique).
     - `onConflict = "overwrite"` → fall through to update path.
  2. `adf.markdownToAdf(body)` → ADF JSON.
  3. **Create path** (no existing page):
     - `POST /wiki/api/v2/pages` with `{ spaceId, parentId: subParents[type], title, body: { representation: "atlas_doc_format", value: <adf JSON string> } }` → numeric page id. `spaceId` is the **numeric** id cached in config (§6.1), not `spaceKey`.
     - For each `pwiki-*` field: `properties.upsert(pageId, key, value)` (helper from §2.5.1) — first call lists, subsequent calls POST since the page has no properties yet.
     - Sync labels: for each tag, `POST /wiki/rest/api/content/<id>/label` with `{ name: tag }` (v1 endpoint — label management API has no v2 equivalent; one POST per tag, idempotent server-side).
  4. **Update path** (overwrite):
     - `GET /wiki/api/v2/pages/<id>` → current version number.
     - `PUT /wiki/api/v2/pages/<id>` with new title, new body, `version.number = current + 1`.
     - On 409 → one auto-retry with fresh GET; second 409 → exit 1 `version-conflict`.
     - For each property whose value differs: `properties.upsert(pageId, key, value)`.
     - Sync labels diff: `DELETE /wiki/rest/api/content/<id>/label?name=<x>` for removed tags; `POST` for added tags.
  5. Return `{ path: "confluence://<type>/<slug>", id, slug, created, viewUrl }`.

`viewUrl` is an additional output field, not part of `path`. Skills use `path` for identity and dispatch back to CLI; `viewUrl` is human-clickable display only.

### 3.4 `mutatePage(path, mutations)`

- **FS:** unchanged.
- **Confluence:** GET properties → apply mutations on the reassembled frontmatter object (reuses the same mutation logic as FS) → diff → `properties.upsert` only for changed properties; if `tags` changed, sync labels (POST/DELETE diff). **Body is never touched** — no body GET, no body PUT, no page-body version increment. Each property has its own server-side version, bumped only on upsert. No body PUT means no spurious entry in page history.

### 3.5 `movePage(fromPath, toPath)`

- **FS:** unchanged — `fs.rename`.
- **Confluence (used by promote):**
  1. Resolve `fromPath` → numeric id; GET current page (title, body, version).
  2. Compute new `type` and `slug` from `toPath`.
  3. `PUT /wiki/api/v2/pages/<id>` with new `parentId = subParents[newType]`, **title preserved verbatim from current page**, body preserved, `version.number = current + 1`. Confluence title is human-readable display; the new slug is reflected only in the `pwiki-id` property, not in the title (matches FS semantics, where promote does not rewrite the page title).
  4. `properties.upsert` for changed `pwiki-id` and `pwiki-type`.

Promote-specific frontmatter mutations (drop `pwiki-question`, drop `pwiki-informed-by`, add `pwiki-sources`, set `pwiki-status = active`, set `pwiki-updated = today`) are applied by the `promote` command via `mutatePage` after `movePage`, exactly as v1 does on FS.

### 3.6 `listPages({ types?, in? })`

- **FS:** unchanged.
- **Confluence:**
  - `in: 'pages'` (default): one CQL with type disjunction: `ancestor = <rootPageId> AND (property["pwiki-type"] = "concept" OR property["pwiki-type"] = "person" OR ...)`. CQL does not support `IN (...)` for custom properties, so the builder generates `OR` chains. Sub-parents and Index are excluded because they have no `pwiki-type` property — the OR-list of type values is a positive filter, naturally skipping them. Pagination handled inside the destination via CQL `start`/`limit`.
  - `in: 'raw'`: **always** delegates to FS — raw lives on disk in both modes. The destination calls into `paths.mjs` / `fm.mjs` directly for raw scan.
  - `in: 'all'`: union of the two.

### 3.7 `search(query, options)`

- **FS:** unchanged — BM25-lite.
- **Confluence:** Single CQL:
  ```
  text ~ "<escaped query>"
    AND ancestor = <rootPageId>
    [ AND (property["pwiki-type"] = "concept" OR ...) ]            -- if --type filter set
    [ AND labels = "<tag1>" AND labels = "<tag2>" AND ... ]        -- if --tags filter set; AND semantics intersection
  ```
  Tags are filtered natively via Confluence labels (dual-encoded per §2.5), avoiding the N extra property fetches that would otherwise be needed. Type filter uses OR disjunction (CQL has no `IN` for custom properties). Confluence-returned relevance becomes `score`. Excerpts come from `expand=excerpt`. Scores are not comparable across backends; skills already do not cross-compare.

### 3.8 `lint(options)`

See §4 for full mapping. Output schema (grouped JSON, text format) is unchanged from v1 §3.5.

### 3.9 `applyBacklinks({ targetPath, maxSuggestions?, force? })`

- **FS:** unchanged — pure logic in `backlinks.mjs`.
- **Confluence:**
  1. `readPage(targetPath)` → title; resolve target numeric page id.
  2. CQL `text ~ "<title>" AND ancestor = rootPageId AND id != <target id>`.
  3. Cap at `maxSuggestions` (default 20).
  4. For each candidate: `GET` ADF body, walk text nodes, find first text node matching the exact whole-word title that is not inside an existing `link` mark or `code` mark or `codeBlock`.
  5. If candidate count > suspicion threshold (20) and `force` not set → return `{ suspicious: true, candidates: [...] }`, exit 2.
  6. Otherwise: insert a `link` mark whose `href` is the **real Confluence URL** of the target page (`<siteUrl>/wiki/spaces/<spaceKey>/pages/<numericId>`) into each matched node, `PUT` each modified page (one body PUT per page, one version bump). The numeric-id form is the only shape that renders as a clickable internal link in Confluence UI; the synthetic `confluence://<type>/<slug>` shape is for CLI/skill identity, not body content.
  7. Return `{ target, title, inserted: [{ file, line }], total }`. In Confluence mode `file = path` and `line = -1` (sentinel — line numbers do not apply).

Auto-retry on 409 (per §5.3) applies here too.

### 3.10 `regenerateIndex()`

- **FS:** unchanged — writes `docs/wiki/index.md`.
- **Confluence:**
  1. `listPages({ in: 'pages' })` to enumerate all four types.
  2. Render index ADF (group-by-type, summary line per page).
  3. Ensure an "Index" stub page exists directly under `rootPageId` (find-or-create idempotent via `pwiki-role = "index"` lookup, title `"Index"`; no `pwiki-type` since Index is not a wiki entry — `pwiki-role` is what lint uses to skip it).
  4. `PUT` the Index page with the new ADF body and incremented version.
  5. Return `{ path: "confluence://index", groups, written: true }`.

---

## 4. Lint adaptation

| Check | FS semantics | Confluence semantics |
|---|---|---|
| `frontmatter` | File breaks `schema.mjs` | Page under wiki tree but `pwiki-*` properties missing / type-inconsistent with schema / `pwiki-type` does not match sub-parent |
| `dead-sources` | `sources:` references missing FS path | Identical — `sources:` are always FS paths (raw stays on FS); check is a clean port |
| `dead-links` | Markdown link `(./bar.md)` to missing file | ADF `link` marks whose `href` is a Confluence page URL (`<siteUrl>/wiki/spaces/<spaceKey>/pages/<numericId>`): extract numeric id, check page exists under `rootPageId` and has a `pwiki-id` property; external URLs skipped |
| `orphan-pages` | Concept page no one links to | Single walk: collect outgoing `link` nodes from ADF of every page under `rootPageId`, build incoming-set, find pages with 0 incoming (excluding Index). Body cache reused across orphan / underlinked |
| `underlinked` | Concept with < 3 outgoing links | Same walk: count outgoing `link` nodes per page, filter `type = concept AND outgoing < 3 AND status ≠ draft` |
| `stale` | `updated:` older than N days | Read `pwiki-updated` via CQL; no body fetches |

**New Confluence-only checks:**

- **`drift`** — page in the wiki tree (descendant of `rootPageId`) without a `pwiki-id` property AND without `pwiki-role`. Created by a human in UI; pwiki does not manage it. Warning, not error.
- **`misparented`** — page has `pwiki-type: concept` but sits under Sources sub-parent (or similar mismatch). Sign of a manual UI move. Error: future `mutatePage` would mislocate it.

**Structural artifact exemption.** Every lint check excludes pages with `property["pwiki-role"] IS NOT EMPTY` (i.e. sub-parents Concepts/People/Sources/Queries and the Index page). They are pwiki-managed structural pages, not wiki entries.

**Cost:** a full lint in Confluence mode is on the order of one CQL for frontmatter/drift/misparented + one CQL for stale + one CQL + N body fetches for dead-links / orphan-pages / underlinked. Lint runs on user request, not in tight loops. HTTP client batches and respects rate limits (§5).

Exit code stays 0 — lint reports, never decides.

---

## 5. Error handling, HTTP, retries

### 5.1 HTTP client (`confluence/http.mjs`)

Small wrapper over `node:https`. Responsibilities:

- **Auth.** `Authorization: Basic base64(email + ":" + token)` on every request. Email and token read once from env vars at client construction.
- **Base URL.** From `confluence.siteUrl` in config. Methods take path (e.g. `/wiki/api/v2/pages`) and join.
- **JSON default.** `Content-Type: application/json` on POST/PUT, `Accept: application/json` always. Body `JSON.stringify`, response `JSON.parse`.
- **Retries.** Exponential backoff on 429, 502, 503, 504 for GET / PUT (PUTs are idempotent in our usage — body updates carry explicit version, property updates are PUT-by-id). Max 3 retries, base 1000 ms, multiplier 2. Honors `Retry-After`.
- **Idempotent POSTs are retried; page-create POST is not.** Label POST (`/wiki/rest/api/content/<id>/label`) and property POST (`/wiki/api/v2/pages/<id>/properties`) are idempotent-by-key — adding the same label or creating a property with a key that already exists is a no-op on the server (the property POST returns 400 with `keyAlreadyExists` which the helper treats as success-by-other-means). Only `POST /wiki/api/v2/pages` (page creation) is excluded from retries because a transient 5xx may have already created the page, and a retry would duplicate. Callers (`writePage`) check `pageExists` first to minimize this risk.

No pooling, streaming, multipart. JSON request/response only.

### 5.2 Failure classes → exit codes

| Failure | Exit | `error.code` | Skill response |
|---|---|---|---|
| 401, 403 | 1 | `auth-failed` | Show "Check PWIKI_CONFLUENCE_EMAIL / PWIKI_CONFLUENCE_TOKEN; verify token grants access to space" |
| init: 404 on rootPageId / spaceKey | 1 | `config-invalid` | "Parent page not found in space. Re-run /p-wiki:init." |
| 404 on `readPage` (page deleted in UI) | 1 | `page-not-found` | "Page `<path>` no longer exists in Confluence" |
| 429 after 3 retries | 1 | `rate-limited` | "Confluence rate-limited; retry in a few minutes" |
| 5xx after 3 retries | 1 | `network-error` | "Confluence is unavailable; retry later" |
| `ECONNREFUSED`, `ETIMEDOUT`, DNS | 1 | `network-error` | Same |
| 409 on PUT after one auto-retry | 1 | `version-conflict` | "Page was modified concurrently; re-run the command" |
| `pageExists` true and `onConflict = fail` | 2 | `slug-taken` | Existing slug-conflict prompt (overwrite / date-suffix) |
| `promote` target exists | 2 | `target-exists` | Existing callout to user |
| Schema violation (e.g. setting a field disallowed for type) | 2 | `schema-violation` | Existing behavior |
| Uncaught throw in destination | 3 | `internal` | "File an issue against p-wiki" |

Skills already differentiate by exit code; v2 only adds `error.code` parsing for more specific messages on `auth-failed`, `rate-limited`, `network-error`, `page-not-found`, `version-conflict`, `config-invalid`.

### 5.3 Version conflicts on body PUT

Between our GET (for current version number) and PUT, a UI edit may race ahead → 409. Strategy: **one auto-retry with a fresh GET**. Second 409 → exit 1 `version-conflict`. `compile` does batch writes; a single transient 409 from a concurrent edit must not abort the whole run.

`mutatePage` does not have this problem because it only updates properties (separate endpoints, per-property versioning handled server-side).

### 5.4 Verbose logging

`--verbose` writes single-line traces to stderr:

```
[confluence] GET /wiki/api/v2/pages/12345 → 200 (124ms)
[confluence] retry 1/3 on 429 after 1000ms
[confluence] POST /wiki/api/v2/pages → 200 (id=12356, 312ms)
```

Without `--verbose`: silent on success, standard stderr message on failure. Response bodies are never logged (PII risk).

---

## 6. Configuration and `init` UX

### 6.1 Config file

`docs/wiki/.pwiki.json` (JSON — zero-deps parse via `JSON.parse`; YAML parser stays scoped to frontmatter):

```json
{
  "destination": "confluence",
  "confluence": {
    "siteUrl": "https://exinity.atlassian.net",
    "spaceKey": "ENG",
    "spaceId": "98765432",
    "rootPageId": "123456",
    "subParents": {
      "concept": "123457",
      "person":  "123458",
      "source":  "123459",
      "query":   "123460"
    }
  }
}
```

`spaceId` is the **numeric** id required by `POST /wiki/api/v2/pages` (the v2 API does not accept `spaceKey` directly for create-page). `spaceKey` is kept for human-readable lint messages and for CQL `space = "<key>"` filters where v1 endpoints want a key. Both are cached at init.

`subParents` is cached at init so every `writePage` does not re-resolve. Absence of file ⇒ FS destination (preserves v1 wikis).

### 6.2 `pwiki init` Confluence flow

```
1. node --version ≥ 18
2. Read PWIKI_CONFLUENCE_EMAIL, PWIKI_CONFLUENCE_TOKEN env vars.
   Missing → exit 1 with instruction (link to Atlassian token docs).
3. Prompt: destination? (fs | confluence). Default fs.
4. If confluence:
   a. Prompt: site URL.
   b. GET /wiki/api/v2/spaces → list accessible spaces. Show keys + names. Capture both `spaceKey` and numeric `spaceId` for each.
   c. Prompt: space key → keep both spaceKey and spaceId for the selected space.
   d. Prompt: parent page title or numeric ID.
      If title: CQL lookup under that space; if multiple matches, prompt to disambiguate; if no match, exit 1 with "Create the parent page in Confluence UI first, then re-run /p-wiki:init".
   e. GET that page to validate access.
   f. Ensure sub-parents: for each of {Concepts, People, Sources, Queries}, find-or-create child page under rootPageId. Find via `pwiki-role` property lookup; on create, set `pwiki-role = "sub-parent:<type>"` so subsequent init runs are idempotent and lint skips them (§4).
   g. Write docs/wiki/.pwiki.json (including `spaceId` and `subParents`).
5. Scaffold docs/wiki/CLAUDE.md, raw/, queries/ marker as in FS mode.
6. Write .claude/rules/p-wiki.md.
```

`init` is interactive in both modes already; the Confluence branch adds prompts but no new prompting framework — same `readline` flow.

---

## 7. Skill migration

Skills do not branch on destination. All v1 skills (`init`, `ingest`, `compile`, `query`, `lint`) keep their public interface. Two adjustments:

1. **Error messages.** Skills now parse `error.code` from JSON for failure classes listed in §5.2 and show a specific message instead of forwarding raw stderr. Implementation is a small switch in each skill's error path, replacing today's "echo stderr and stop".
2. **`init`** gains the Confluence-destination prompt branch. The existing prompts (Node version check, scaffold) stay identical for FS mode.

`ingest` and `compile` are unchanged in Confluence mode. `ingest` only writes raw-* files (FS-only by design — see §1.2). `compile` reads raws from FS, calls `pwiki new`/`pwiki set` for synthesis — the CLI dispatch through `resolveDestination` routes those writes to Confluence transparently; the skill body never references file paths or destinations directly.

`docs/wiki/CLAUDE.md` template (`wiki-claude-md.template.md`) gains a "Storage backend" section under "CLI tool", noting that pages may live in Confluence and links between pages use the `confluence://<type>/<slug>` shape. No other rule changes — `sources:` are still repo-relative paths because raw is FS-only.

---

## 8. Testing

Three layers on vitest + TypeScript (`tools/__tests__/`).

### 8.1 Unit tests (offline)

- `adf.mjs` direction-by-direction tests on a corpus of fixtures (h1-h3, paragraphs, ordered/unordered/nested lists, inline marks bold/italic/code/link, fenced code blocks with language, blockquotes): `markdownToAdf(input)` is a deterministic snapshot match against a fixture ADF JSON; `adfToMarkdown(adf)` is asserted equal to a canonicalized markdown form (collapse trailing whitespace, normalize list markers). Strict round-trip equality is not required because some markdown forms canonicalize (e.g. `*` vs `-` list markers); the contract is that markdown → ADF → markdown is stable on the canonical form.
- `identity.mjs`: path↔(type, slug) parse, cache hit/miss, malformed input.
- CQL builder: query generation from `(query, types, tags, ancestor)`; escaping of special characters in `text ~`.
- `http.mjs`: injected fake transport; backoff curve, `Retry-After` honoring, no-retry on POST, retry-cap of 3.
- Error code mapping: synthetic Confluence responses → expected `(exit, error.code)`.
- `config.mjs`: read / write / schema validation; missing file ⇒ FS default; invalid file ⇒ exit 1 `config-invalid`.

### 8.2 Destination contract tests (offline, fake HTTP)

`destination-contract.test.ts` already verifies shape conformance and re-runs against the Confluence destination with an injected fake HTTP transport. Fake is ~150 lines, in `__tests__/fixtures/fake-confluence.mjs`, handling:

```
GET   /wiki/api/v2/pages/:id
POST  /wiki/api/v2/pages
PUT   /wiki/api/v2/pages/:id
GET   /wiki/api/v2/pages/:id/properties
PUT   /wiki/api/v2/pages/:id/properties/:key
GET   /wiki/rest/api/search?cql=...
```

In-memory state: `Map<numericId, { title, parentId, version, body, properties }>`. Naive substring matching for CQL `text ~`. Hand-rolled, zero deps.

Confluence-specific semantic tests:

- `pageExists` true after `writePage` for the same `(type, slug)`.
- `writePage` with `onConflict = fail` against existing pwiki-id → exit 2.
- `mutatePage --add-tag` updates properties only; fixture verifies body bytes unchanged and body version unchanged.
- `movePage` (promote) reparents and updates `pwiki-type`.
- `applyBacklinks` over a corpus with > threshold matches → `suspicious: true`, no writes.
- Lint `drift` fires on a synthetic page without `pwiki-id`.
- Lint `misparented` fires on a page whose `pwiki-type` mismatches its parent.
- 409 simulation via preconfigured fake response → one auto-retry, then exit 1 `version-conflict`.

### 8.3 E2E against real Confluence

`confluence-e2e.test.ts`, gated by `PWIKI_E2E_CONFLUENCE=1`. Reads additional env:

```
PWIKI_E2E_SITE_URL=https://<your>.atlassian.net
PWIKI_E2E_SPACE_KEY=PWIKITEST
PWIKI_E2E_ROOT_PAGE_ID=<id>
```

`it.skipIf(!process.env.PWIKI_E2E_CONFLUENCE)` guards every test. CI does not run e2e — runs locally before tagging v2.0.0.

Scenario: `init` (create sub-parents) → `new concept Foo` → `search "Foo"` (must find) → `set --bump-updated` → `new query Q` (with `--informed-by`) → `promote Q` → `applyBacklinks foo` (corpus empty, must return 0 inserts) → `regenerateIndex` → `lint` (errors must be 0; warnings allowed) → cleanup (DELETE created pages).

**Sandbox requirement:** dedicated test space (e.g. `PWIKITEST`) — never against a real working space. Documented in `plugins/p-wiki/CONTRIBUTING.md` (new file).

### 8.4 Test ordering ↔ layered approach

Implementation rolls out in five layers; each layer ships with green tests before the next starts:

| Layer | Implementation | Tests added |
|---|---|---|
| 1 | ConfluenceDestination skeleton + `http.mjs` + `config.mjs` + `adf.mjs` + `identity.mjs` + `tree.mjs` | All §8.1 unit tests |
| 2 | `writePage` + `pageExists` + `listPages` | Contract for these methods through fake; e2e for `pwiki new` |
| 3 | `readPage` + `mutatePage` + `movePage` | Contract; e2e for `pwiki set` and `pwiki promote` |
| 4 | `search` + `lint` (including `drift`, `misparented`) | Contract; e2e for `pwiki search` and `pwiki lint` |
| 5 | `applyBacklinks` + `regenerateIndex` | Contract; e2e full scenario |

Each layer must leave the existing FS test suite green — v2 changes do not touch `destinations/fs.mjs` or its helpers, but the test bot enforces this invariant. End of layer 5 is the v2.0.0 ship. Between layers, Confluence mode is partially functional (e.g. after layer 2 you can `pwiki new` but not `pwiki search`); this is acceptable because Confluence mode is opt-in via `.pwiki.json` — users without that file see no change.

CI runs unit + contract on every push; e2e runs locally before the `v2.0.0` git tag.

---

## 9. Backwards compatibility

- **v1 FS wikis keep working.** No `.pwiki.json` ⇒ resolver falls back to FS. No code paths in `destinations/fs.mjs` change.
- **Frontmatter schema unchanged.** Both backends enforce `schema.mjs`.
- **Skill public interface unchanged.** Same slash commands, same arguments, same `argument-hint`s.
- **CLI flags unchanged.** All v1 flags (`--format`, `--severity`, `--on-conflict`, etc.) keep their meaning.
- **New environment requirement** *only* for users who pick the Confluence destination: `PWIKI_CONFLUENCE_EMAIL` and `PWIKI_CONFLUENCE_TOKEN`. FS users see no change.
- **Templates.** `wiki-claude-md.template.md` gains a "Storage backend" section. Other templates unchanged.

Version bump: **v1.x → v2.0.0** — justified by the new optional environment requirement, the new init configuration shape, and the addition of the Confluence destination as a major feature.

---

## 10. Out of scope for v2

- **Migration `fs → confluence` or `confluence → fs`.** Deferred to v2.1; design depends on usage patterns observed after v2 ships.
- **Round-trip preservation of user edits in Confluence UI.** v2 policy is overwrite; future versions may add detect-and-warn.
- **Server / Data Center support.** Not planned.
- **Adopting a hand-created page (`pwiki adopt <pageId>`).** v2 reports drift; adoption stays manual (edit page properties in UI).
- **Raw sources in Confluence.** Raw remains FS-only.
- **OS keychain / OAuth2.** Env-var token only.

If any of these become priorities, they get their own brainstorming session and design doc.
