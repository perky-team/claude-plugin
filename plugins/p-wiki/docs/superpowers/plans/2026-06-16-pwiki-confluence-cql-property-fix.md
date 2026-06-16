# Confluence `property[...]` CQL Fix — Implementation Plan

> **For agentic workers:** RECOMMENDED SUB-SKILL: superpowers TDD. Steps use checkbox (`- [ ]`) syntax. **Order matters: the fixture must red the suite before any code change.**

**Goal:** Make the Confluence backend work against live Confluence Cloud by removing all `property[...]` CQL (which the live parser rejects with HTTP 400) in favour of `ancestor`-scan + in-memory property filtering.

**Design:** `2026-06-16-pwiki-confluence-cql-property-fix-design.md`

**Tech Stack:** Node ESM (`tools/`), Vitest, `createFakeConfluence` fake transport.

---

## Task 0 — Make the fixture tell the truth (RED gate)

- [x] In `tools/__tests__/fixtures/fake-confluence.mjs`, add `unsupportedCqlReason(cql)` returning a `Could not parse cql` message when the CQL contains `property[` or `content.property`.
- [x] In the `/wiki/rest/api/search` branch, return `{ status: 400, body: { message } }` when `unsupportedCqlReason` matches, before matching.
- [x] Remove the `property["k"]="v"` and `property[...] IS NOT EMPTY` clauses from `cqlMatches`.
- [x] **Run `npx vitest run` — confirm the suite goes RED** across tree / pageExists / deletePage / listPages / search / init-idempotency with HTTP 400. (Observed: 36 failing.)

## Task 1 — `tools/lib/confluence/search.mjs`

- [x] Delete `typeDisjunction`; `buildSearchCql({ query, rootPageId, tags })` → `text ~ "q" AND ancestor = R` + `labels = "…"` per tag. No `property[...]`.
- [x] Remove `buildListCql` (listing moved to the children API — see Task 3).

## Task 2 — read-your-writes traversal (pivot after live e2e)

Live e2e proved CQL `ancestor` search lags writes (children API is read-your-writes).

- [x] New `tools/lib/confluence/children.mjs` — `listChildren(http, parentId)`, paginated via `_links.next`.
- [x] `tree.mjs` `findByRole` → list the root's children, read each one's properties, match `pwiki-role`. No CQL.

## Task 3 — `tools/lib/destinations/confluence.mjs`

- [x] Memoized `ensureIdentityIndex()`: `listChildren(subParent)` per type, `properties.readAll`, `identity.set(pwiki-type, pwiki-id, id)`.
- [x] `pageExists` → cache hit, else `ensureIdentityIndex()` then cache check.
- [x] `deletePage` → resolve cold-cache id via `ensureIdentityIndex()`.
- [x] `listConfluencePages` → `listChildren` per sub-parent + in-memory `types` filter, keep `!fm.type` guard. Remove dead `searchAllHits`/`nextSearchPath`.
- [x] `search` → `buildSearchCql` (no types) + in-memory `opts.type` filter; `total = typeFilter ? results.length : totalSize`.

## Task 3b — CLI handlers must `await` (pivot after live CLI check)

Live CLI check found `new` reported `{"created":false}` because the handler never awaited the async destination.

- [x] `await` every async destination call in `pwiki.mjs` (`new`/`set`/`promote`/`search`/`lint`/`backlinks`/`index`); `get` already did. No-op for the sync FS backend.

## Task 4 — Tests to green

- [x] `confluence-search.test.ts`: assert no `property[` in CQL (drop `buildListCql` test).
- [x] `confluence-tree.test.ts`: drive `findByRole`/`ensureSubParent` through the hardened `createFakeConfluence` fixture (children API).
- [x] `fake-confluence.test.ts`: guard — property/content.property CQL → 400; `ancestor` still served. Add v2 children endpoint.
- [x] `destination-confluence-fixes.test.ts`: rewrite `#4` to children-API pagination.
- [x] `destination-confluence-write.test.ts`: `listPages` type filter; `deletePage` cold hit/miss.
- [x] `destination-confluence-search.test.ts`: `search` type filter keeps/drops by type.
- [x] **Run `npx vitest run` — full unit suite GREEN.** (Observed: 950 passing.)

## Task 5 — Version + docs

- [x] CLI `VERSION` `3.2.2` → `3.2.3` (`tools/pwiki.mjs`) and `cli-entry.test.ts` assertion.
- [x] `.claude-plugin/plugin.json` `"version": "4.8.3"`.
- [x] Design spec + this plan updated.
- [x] `node scripts/validate.mjs` passes.

## Task 6 — Cross-link write rewrite (decided: fix now)

Live e2e exposed that `writePage` stores portable `confluence://type/slug` body
links verbatim → Confluence sanitizes them to `#`.

- [x] Fake transport: sanitize unknown-scheme link hrefs to `#` (models Confluence) — reds a new write test.
- [x] `confluence.mjs`: `parseWikiLink` accepts portable `confluence://type/slug`; `rewriteBodyForStorage` (via `rewriteCrossLinks`) rewrites body cross-links to native URLs in `writePage` + `mutatePage(setBody)`.
- [x] `destination-confluence-write.test.ts`: portable cross-link → native URL (not `#`).
- [x] multi-dest e2e: create B before A so the link resolves (forward-ref on a single direct write is unsupported by design).

## Task 7 — Live e2e (run against TRADING / 2629238836)

- [x] cold-cache identity/role test (direct property-CQL regression guard) — **passes live**.
- [x] CLI-binary test (init→new→get→set→get) — **passes live**.
- [x] multi-dest sync (incl. cross-link rewrite, delete, resync) — **passes live**.
- [x] full scenario (new→search→set→query→promote→index→lint) — **passes live**; `search` step is best-effort (Confluence full-text index latency, not a code defect).
- [x] **All four e2e tests green** against real Confluence.
