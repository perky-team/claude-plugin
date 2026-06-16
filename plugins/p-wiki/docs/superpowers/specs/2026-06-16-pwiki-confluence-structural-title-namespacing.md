# Design: namespace Confluence structural-page titles per-wiki

**Date:** 2026-06-16
**Status:** Drafted (brainstorming)
**Targets:** `plugins/p-wiki` — CLI minor (`tools/pwiki.mjs` 3.2.3 → 3.3.0, `plugin.json` 4.8.3 → 4.9.0)
**Predecessor:** `2026-06-16-pwiki-init-fs-primary-confluence-mirror-fix.md`

---

## 1. The bug

p-wiki creates five **structural** pages per wiki on a Confluence destination:
four sub-parent containers (`Concepts`, `People`, `Sources`, `Queries`) and one
`Index` page. Their titles are hardcoded (`tools/lib/confluence/tree.mjs`:
`SUB_PARENT_TITLES` and the literal `'Index'`).

In Confluence Cloud **page titles must be unique within a space**. So a second
p-wiki living in the same space — under a *different* root page — cannot create
its own `Concepts`/`People`/… because the title is already taken space-wide.
`init` aborts with:

```
HTTP 400 POST /wiki/api/v2/pages
→ 400 BAD_REQUEST "A page with this title already exists: … same TITLE in this space"
```

**Reproduced on live Confluence Cloud** (space `TRADING`): p-wiki #1 under root A
("test page") claimed `Concepts`/`People`/`Sources`/`Queries`/`Index`
space-wide; `init` for p-wiki #2 under root B ("Technical Specifications") in the
same space → `exit 3`, HTTP 400.

### Why the test suite missed it

`tools/__tests__/fixtures/fake-confluence.mjs` accepted every
`POST /wiki/api/v2/pages` unconditionally — it did **not** model Confluence's
space-scoped title uniqueness. So the collision could only ever appear live. This
is the same class of gap as the CQL-property fix: the fixture was too permissive.

## 2. Why this fix is low-radius

Structural pages are **discovered by the `pwiki-role` content property**, not by
title (`tree.mjs#findByRole` enumerates the root's children and matches the role
in memory). Therefore:

- The container title is purely cosmetic — changing it does not affect
  find-or-create.
- Content pages are parented under containers **by id** (`subParents[type]`),
  cross-links resolve **by id/URL**, and `Index` links to content **by id**.
- Existing wikis keep their bare `Concepts`/… titles: `findByRole` matches them
  by role, so they are neither recreated nor renamed — full backwards
  compatibility.

So renaming structural pages breaks nothing. Content pages are **not** touched.

## 3. Decision

Give every wiki's structural pages a per-wiki (per-root) title prefix:

```
title = `${titlePrefix} — ${baseTitle}`     e.g. "Technical Specifications — Concepts"
```

- **Source of `titlePrefix`:** a new **optional** `titlePrefix` field on the
  Confluence destination block in `.pwiki.json`. If absent at `init`, it defaults
  to the **root page's title** (which is itself unique within the space, so a
  prefix derived from it guarantees unique containers and is human-readable).
- Resolve the root title **once** at `init` and **persist** the computed
  `titlePrefix` into `.pwiki.json`, so `sync` (`ensureStructure`, Pass 0) reuses
  it verbatim — no extra GET, and init/sync can never diverge.
- An optional CLI override `--title-prefix` (primary) / `--mirror-title-prefix`
  (mirror) lets the user set it explicitly. Cheap pass-through; no extra modes.

`findByRole` is unchanged: discovery stays title-independent, which is exactly
what makes the change backwards compatible.

### Separator

`' — '` (space, em dash U+2014, space). Single constant `TITLE_SEP` in
`tree.mjs`; one `structuralTitle(baseTitle, titlePrefix)` helper used by both
`init` and `sync` so they cannot drift.

### Backwards compatibility

- Old config has no `titlePrefix` → `structuralTitle` returns the bare base title
  (`Concepts`, `Index`). `ensureSubParent`/`ensureIndex` only set the title on
  **create**; existing containers are found by role and left alone.
- `regenerateIndex` sets the Index title on every PUT — it now uses
  `structuralTitle('Index', c.titlePrefix)`, so a no-prefix config keeps `Index`
  (no rename), and a prefixed (init-time) config keeps `"<prefix> — Index"`.

## 4. Implementation

### 4.1 `tools/lib/confluence/tree.mjs`

```js
const TITLE_SEP = ' — ';
export function structuralTitle(baseTitle, titlePrefix) {
  return titlePrefix ? `${titlePrefix}${TITLE_SEP}${baseTitle}` : baseTitle;
}
export async function ensureSubParent(http, spaceId, rootPageId, type, titlePrefix) { … title = structuralTitle(SUB_PARENT_TITLES[type], titlePrefix) … }
export async function ensureIndex(http, spaceId, rootPageId, titlePrefix) { … title = structuralTitle('Index', titlePrefix) … }
```

The new 5th/4th param is optional → existing 4-arg/3-arg callers keep bare
titles. `findByRole` untouched.

### 4.2 `tools/pwiki.mjs` — `resolveConfluenceBlock`

Capture the root title while resolving `rootPageId` (numeric branch: from the
existing GET; title branch: the matched title / the passed `parent`). Compute
`prefix = titlePrefix ?? rootTitle`, pass it to `ensureSubParent`, and store it on
the returned block:

```
{ kind: 'confluence', siteUrl, spaceKey, spaceId, rootPageId, titlePrefix: prefix, subParents }
```

`initConfluence` passes `titlePrefix: args['title-prefix']` for the primary and
`args['mirror-title-prefix']` for the mirror.

### 4.3 `tools/lib/destinations/confluence.mjs`

- `ensureStructure` → `ensureSubParent(http, c.spaceId, c.rootPageId, type, c.titlePrefix)`.
- `regenerateIndex` → `ensureIndex(http, c.spaceId, c.rootPageId, c.titlePrefix)` and
  PUT `title: structuralTitle('Index', c.titlePrefix)` (import the helper).

### 4.4 `tools/lib/config.mjs` — `validateConfig`

In the confluence block: `titlePrefix` is optional; if present it must be a
non-empty string.

## 5. Regression protection (TDD, fixture first)

### 5.1 Fixture models space-scoped title uniqueness

`fake-confluence.mjs`: track `spaceId` per page (default `null` for
`initialPages`, taken from `body.spaceId` on POST). `POST /wiki/api/v2/pages`
rejects a duplicate `(title, spaceId)` with `400 "A page with this title already
exists: <title>"`. Because existing fixtures don't set `spaceId` on
`initialPages` (→ `null`) while real POSTs carry the block's `spaceId`, this is
**safe for the existing suite** — a collision needs matching title **and**
spaceId.

### 5.2 Tests

- **tree:** two wikis in one space — `ensureSubParent` without prefix collides
  (rejects `{status: 400}`), with prefix succeeds and titles
  `"<prefix> — Concepts"`. Same for `ensureIndex`.
- **tree backwards-compat:** an existing role-matched container (title
  `Concepts`) is returned by `ensureSubParent` even when a prefix is passed — no
  POST, no rename.
- **init:** two `initConfluence` runs in one space under different roots both
  succeed via auto-prefix; `titlePrefix` is persisted (= root title). Explicit
  `--title-prefix` is honored and applied to created containers.
- **sync:** `ensureStructure` with a config carrying `titlePrefix` creates a
  missing sub-parent with the prefixed title (proves Pass 0 reuses the saved
  prefix).

## 6. Versioning

New optional config field + new optional CLI flags = backwards-compatible
extension ⇒ **minor**:

- `tools/pwiki.mjs` `VERSION`: 3.2.3 → 3.3.0
- `.claude-plugin/plugin.json` `version`: 4.8.3 → 4.9.0

(The monorepo release tag is chosen later by the release process.)
