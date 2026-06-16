# Design: Confluence backend — stop using unsupported `property[...]` CQL

**Date:** 2026-06-16
**Status:** Implemented
**Targets:** `plugins/p-wiki` v4.8.2 → v4.8.3 (patch — bug fix, backwards-compatible; Confluence backend now works against live Confluence Cloud)
**Predecessor:** `2026-05-15-pwiki-v2-confluence-destination-design.md` (introduced the Confluence destination and the property-CQL identity/role resolution this fixes)

---

## 1. Problem

The Confluence backend resolved page **identity** and **role** by sending CQL
queries over content properties, e.g.

```
property["pwiki-role"] = "sub-parent:concept" AND ancestor = <id>
property["pwiki-id"] = "<slug>" AND property["pwiki-type"] = "<type>" AND ancestor = <subParent>
(property["pwiki-type"] = "concept" OR …)   # list/search type filter
```

**Confluence Cloud's CQL parser does not support `property[...]`.** Searching by
an arbitrary content property requires a registered content-property index from
a Connect/Forge app, which p-wiki is not. Properties written via the v2
properties API are simply not CQL-searchable. The endpoint returns
`HTTP 400 "Could not parse cql"`.

Verified directly against a live instance (basic auth, email + API token):

| CQL | Result |
|---|---|
| `ancestor = <pageId>` | **200** |
| `property["pwiki-role"] = "…" AND ancestor = <id>` | **400** "Could not parse cql" |
| `content.property[pwiki-role] = "…" AND ancestor = <id>` | **400** same |

So every operation that locates a page by identity/role was broken live:
`init` / `ensureStructure` (`findByRole` → `ensureSubParent`/`ensureIndex`),
`pageExists` (→ `writePage`/`movePage`), `deletePage`, `listPages`, and the
type filter inside `search`.

### Why tests didn't catch it

The fake transport (`tools/__tests__/fixtures/fake-confluence.mjs`) implemented
its own CQL that **accepted** `property[...]`. The fixture lied, so the entire
unit/contract suite was green while live publishing failed. The live e2e
(`PWIKI_E2E_CONFLUENCE`) had evidently never been run against a real instance.

## 2. Design

Eliminate `property[...]` from all CQL. Use only fields Confluence Cloud honors
(`ancestor`, `text ~`, `labels`, `id !=`), then read properties per page via the
v2 properties API and filter **in memory** — the pattern `lint.mjs` already uses
successfully against live Confluence.

### 2.1 Fixture tells the truth first (regression gate)

`fake-confluence.mjs` rejects any search CQL containing `property[` or
`content.property` with `HTTP 400 "Could not parse cql : …"`, exactly like the
real parser, and drops the `property[...]` clauses from its matcher. This is the
gate: it reddens the whole broken class before any code change, proving the
fixture reproduces reality. Without this step, any "fix" would pass tests and
stay broken live.

### 2.2 Identity / role resolution — v2 children API (read-your-writes)

First attempt used `ancestor = …` CQL search (the field `lint.mjs` uses). Live
e2e immediately disproved it: **CQL search is eventually-consistent — it lags
writes by seconds**, so resolving structure/identity right after a write (init,
ensureStructure, pageExists after a create) missed freshly created pages and
`ensureStructure` tried to re-create existing sub-parents → `HTTP 400` duplicate
title. Verified directly against live Confluence:

| immediately after creating a page | result |
|---|---|
| `GET /wiki/api/v2/pages/<root>/children` | page **present** (read-your-writes) |
| `GET /wiki/rest/api/search?cql=ancestor = <root>` | page **absent** (index lag) |

So structural/identity/list reads go through the **v2 children API** (`listChildren`
in `tools/lib/confluence/children.mjs`, paginated via `_links.next`), which reads
the page tree from the primary store and is read-your-writes consistent. CQL is
reserved for genuine full-text `search` only.

- `findByRole` lists the root's direct children and matches `pwiki-role` in memory
  (structural pages — sub-parents + index — are direct children of root, ≈5).
- `ensureIdentityIndex()` (memoized) lists each sub-parent's children, reads their
  properties, and populates `createIdentityCache` with `(pwiki-type, pwiki-id) →
  numericId`. Built at most once per run. `pageExists`/`deletePage` resolve a
  cold-cache slug through it.

### 2.3 List / search

- `listConfluencePages` lists each type's sub-parent children via `listChildren`,
  reads properties, and filters by `pwiki-type` in memory (`!fm.type` drops
  structural pages). `buildListCql` is removed.
- `search` keeps CQL: `text ~ "q" AND ancestor = R` plus `labels = "…"` per tag
  (full-text genuinely needs the search index). Type filtering is in memory.
  Because the search index lags, freshly created pages are not immediately
  searchable — that is inherent to Confluence, not a bug (the live e2e polls).

### 2.4 CLI command handlers must `await` the destination

The CLI was written for the synchronous FS destination, so every command handler
except `get` called the destination method **without `await`** (e.g.
`const r = dest.writePage(...)`). For the async Confluence destination that
yields a Promise, so `r.created` is `undefined` and `new` reported
`{"created":false}` while actually creating nothing. Every handler
(`new`/`set`/`promote`/`search`/`lint`/`backlinks`/`index`) now awaits; `await`
on the FS destination's plain return value is a harmless no-op, so both backends
work. Verified live: `init → new → get → set → get` round-trips through the real
CLI binary.

The real HTTP transport (`makeRealTransport`) was also switched from
`globalThis.fetch` (undici) to `node:https` with a `keepAlive:false` agent: the
CLI calls `process.exit()` immediately after a request resolves, and undici's
keep-alive socket pool tearing down at that moment trips a libuv assertion
(`UV_HANDLE_CLOSING`) that crashes the process with a non-zero exit code on
Windows. A per-request socket that closes before exit avoids it.

### 2.5 Cross-links: rewrite portable `confluence://` to real URLs at write time

Confluence Cloud sanitizes a link href with an unknown URI scheme down to `#` on
storage, so the portable authoring form `confluence://type/slug` written verbatim
into a body is lost (live round-trip yields `[text](#)`). `writePage` and
`mutatePage(setBody)` now rewrite body cross-links to native page URLs before
storing (`rewriteBodyForStorage` → the shared `rewriteCrossLinks`, using the
destination's own `parseWikiLink`/`formatWikiLink`); `parseWikiLink` also accepts
the portable `confluence://type/slug` form. Forward references (target not yet
created) can't resolve on a single direct write and are left verbatim — create
the target first, or let sync's existing 2-pass (stub → resolve) handle ordering.
The fake transport now models Confluence's href sanitization, so this class of
bug can't hide behind the fixture again.

## 3. Affected files

| Path | Change |
|---|---|
| `tools/__tests__/fixtures/fake-confluence.mjs` | reject `property[...]`/`content.property` CQL with 400; add v2 `children` endpoint; sanitize unknown-scheme link hrefs to `#` |
| `tools/lib/cross-links.mjs` | reused by the destination's write-time link rewrite (`rewriteCrossLinks`) |
| `tools/lib/confluence/children.mjs` | **new** — `listChildren` (read-your-writes tree traversal, paginated) |
| `tools/lib/confluence/search.mjs` | drop `typeDisjunction` + `buildListCql`; `buildSearchCql` emits no `property[...]` |
| `tools/lib/confluence/tree.mjs` | `findByRole` lists root's children + reads properties |
| `tools/lib/destinations/confluence.mjs` | `ensureIdentityIndex` + `listConfluencePages` via children API; `pageExists`/`deletePage` via cache; in-memory type filter; remove dead `searchAllHits`; `parseWikiLink` accepts portable form; `writePage`/`mutatePage` rewrite body cross-links to native URLs |
| `tools/pwiki.mjs` | `await` every async destination call in the CLI handlers; `makeRealTransport` → `node:https` (avoids undici exit-crash); CLI `VERSION` `3.2.2` → `3.2.3` |
| `tools/__tests__/*` | fixture-400 + children guard, tree-via-fixture, children-pagination, cold-cache delete, list/search type filters; live `confluence-e2e.test.ts` cold-cache + CLI-binary tests |
| `.claude-plugin/plugin.json` | `"version": "4.8.3"` |

## 4. Backward compatibility

Bug fix only — public behavior of `pwiki` commands is unchanged on the FS
backend and now actually works on Confluence. No schema or config change. →
**patch** bump.

## 5. Test strategy

- **Red gate:** harden the fixture alone → the tree / pageExists / deletePage /
  listPages / search / init-idempotency tests fail with HTTP 400, proving the
  fixture reproduces the live parser.
- **Green:** with the code fix, the full unit suite passes.
- New focused coverage: fixture rejects `property[...]`/`content.property` and
  serves the children API; `findByRole`/`ensureSubParent` via children; children
  pagination; `pageExists`/`deletePage` cold hit/miss; `listPages`/`search` type
  filtering in memory.
- **Live e2e (the only real guard for this bug class):** run
  `confluence-e2e.test.ts` with `PWIKI_E2E_CONFLUENCE=1` against a dedicated
  sandbox space. All four tests pass live (verified against `exinity` space
  `TRADING` under a throwaway root page): the full **scenario**, the
  **multi-destination** sync (incl. cross-link rewrite), **cold-cache** identity/
  role resolution, and the **CLI-binary** round-trip. The scenario's full-text
  `search` step is best-effort — Confluence's search index can lag a write by
  minutes, so it verifies the search call works and confirms the hit only if the
  index caught up (a broken CQL still fails it; result correctness is covered by
  the unit suite). Identity/structure use the read-your-writes children API, so
  only full-text search is latency-sensitive.

## 6. Known gaps / future work

- **Forward-reference cross-links on a single direct write:** a body that links
  to a not-yet-created page can't resolve the URL at write time, so Confluence
  drops it to `#`. Resolved in practice by creating the target first or by
  sync's 2-pass rewrite; a deferred-resolution pass for direct writes is future
  work.
- `lint.mjs` still walks via `ancestor =` CQL (`limit=250`, no `_links.next`),
  so it can both lag writes and truncate wikis > 250 pages — pre-existing.
