# Design: `pwiki` v3 — multi-destination config and `sync` command

**Date:** 2026-05-18
**Status:** Drafted (brainstorming)
**Targets:** `plugins/p-wiki` v2.x → v3.0.0 (major bump — `.pwiki.json` shape change)
**Predecessor:** `2026-05-15-pwiki-v2-confluence-destination-design.md`

---

## 1. Goal

Let the same wiki live in more than one destination at once, with one acting as the canonical source ("primary") and the others as mirrors. A new `pwiki sync` command copies the primary's state into every mirror, 1:1 — page-by-page, including deletions and cross-link rewrites. All other CLI commands continue to operate only on the primary; mirrors are write-only sinks updated on the next `sync` run.

### 1.1 Pains addressed

- Today a team picks FS *or* Confluence — never both. A team that wants Confluence as the canonical knowledge base AND wants a git-tracked FS backup (for offline reads, disaster recovery, IDE diffs) has to maintain two copies by hand.
- The v2 `Destination` interface already abstracts FS and Confluence behind the same contract, so a sync between them is a small layer above an already-symmetric foundation — no architectural rework.

### 1.2 Non-goals

- **Bidirectional sync.** Sync is one-way: primary → mirrors. To go the other way you edit `.pwiki.json`, swap `primary` and a mirror, then run `sync`. No conflict resolution, no per-page direction selection.
- **Selective sync.** No `--to <mirror>` flag, no `--only-types` flag, no incremental "sync since". A single command syncs everything to every mirror. Future selective flags can be added if usage warrants it (§4.3).
- **Continuous / write-through sync.** Normal CLI commands (`pwiki new`, `pwiki set`, `pwiki promote`, etc.) still write only to the primary. Mirrors update on the next explicit `pwiki sync`. This keeps every existing command's surface area unchanged.
- **Round-trip preservation of mirror edits.** A user editing a mirror directly (e.g. tweaking a markdown file in the FS mirror by hand) is silently overwritten on the next sync. Mirrors are not working copies.
- **Sync of `raw/`.** Raw lives on FS in both modes by v2 design (v2 §1.2). Sync ignores it.
- **Attachments, comments, page history.** Out of scope. p-wiki does not model these today.

---

## 2. Architecture

### 2.1 Config shape change (v2 → v3)

**v2 `.pwiki.json`:**

```json
{
  "destination": "confluence",
  "confluence": {
    "siteUrl": "...",
    "spaceKey": "...",
    "spaceId": "...",
    "rootPageId": "...",
    "subParents": { "concept": "...", "person": "...", "source": "...", "query": "..." }
  }
}
```

**v3 `.pwiki.json`:**

```json
{
  "primary": "confluence",
  "mirrors": ["fs-backup"],
  "destinations": {
    "confluence": {
      "kind": "confluence",
      "siteUrl": "...",
      "spaceKey": "...",
      "spaceId": "...",
      "rootPageId": "...",
      "subParents": { "concept": "...", "person": "...", "source": "...", "query": "..." }
    },
    "fs-backup": {
      "kind": "fs",
      "path": "docs/wiki"
    }
  }
}
```

Field semantics:

- `primary` (required, string) — name (= key in `destinations`) of the canonical destination. Every non-sync CLI command operates on `destinations[primary]`.
- `mirrors` (optional, array of strings) — zero or more names that receive a 1:1 copy of the primary on every `pwiki sync`. Each name MUST also key into `destinations`. Defaults to `[]`.
- `destinations` (required object) — map keyed by user-chosen name. Each value is the per-backend config plus an explicit `kind` discriminator (`"fs"` or `"confluence"`). The key is just an identifier — `kind` is authoritative. Multiple instances of the same kind are allowed (e.g. two `confluence` instances pointing at different spaces, distinguished by name).

Default (file absent): treat as `{ primary: "fs", mirrors: [], destinations: { fs: { kind: "fs", path: "docs/wiki" } } }`. Preserves v1 behavior.

### 2.2 Migration of v2 config

On every read of `.pwiki.json`, `config.mjs#readConfig` detects shape:

1. **v3 shape** (`primary` field present) → use as-is.
2. **v2 shape** (`destination` field present, no `primary`) → rewrite in memory to:
   ```json
   {
     "primary": "<old.destination>",
     "mirrors": [],
     "destinations": {
       "<old.destination>": { "kind": "<old.destination>", ...old[old.destination] }
     }
   }
   ```
   Then **persist immediately** — overwrite the file with the v3 shape. Migration is lossless and one-shot.
3. **Neither** → exit 1 with `error.code = config-invalid`, message names the missing/unexpected fields.

A user who never runs a CLI command after upgrade keeps a working wiki — the next CLI invocation does the in-place migration.

### 2.3 Resolver

`tools/lib/destination.mjs#resolveDestination(cwd)` returns:

```
{
  primary: Destination,
  primaryName: string,
  mirrors: Destination[],         // possibly empty, parallel to mirrorNames
  mirrorNames: string[]
}
```

Existing call sites use `.primary` everywhere — a one-line change wherever the resolver was previously expected to return a single `Destination`. Only `pwiki sync` reads `.mirrors`.

Mirror destinations are constructed lazily — `mirrors[i]` is built only if `pwiki sync` actually iterates over it. (Construction can be expensive for Confluence: env-var checks, HTTP-client setup.)

### 2.4 Destination interface additions

Two additions to the `Destination` contract:

```
deletePage(path) → { deleted: boolean, path }
```

- Removes the page identified by `path`.
- Idempotent: deleting a missing page returns `{ deleted: false }`, exit 0 — not an error.
- FS impl: `fs.unlink(<filePath>)` swallowing `ENOENT`.
- Confluence impl: `identity.resolveByPath(path)` → numeric id → `DELETE /wiki/api/v2/pages/<id>`; 404 swallowed.

```
pathFor({ type, slug }) → path             // synchronous; identity-only
```

- Returns the canonical path string for a `(type, slug)` pair without any I/O.
- FS impl: `path.join(root, type, `${slug}.md`)` (POSIX-normalized).
- Confluence impl: `confluence://<type>/<slug>`.

Used by sync to derive destination paths without round-tripping `pageExists`.

### 2.5 `mutatePage` body extension

v2 `mutatePage` accepts property/tag mutations only. v3 adds one more mutation shape for pass 2 of sync:

```
mutatePage(path, { setBody: string })
```

- FS impl: rewrite the file body in place, frontmatter preserved verbatim.
- Confluence impl: `markdownToAdf(body)` → GET current page version → PUT new ADF body with `version.number = current + 1`. Properties untouched. Auto-retry on 409 per v2 §5.3.

Additive — existing mutation shapes (`addTag`, `removeTag`, `set: {...}`) are unchanged. A single `mutatePage` call may include `setBody` together with other mutations; setBody is applied last to ensure ADF re-render sees final properties.

### 2.6 Sync orchestrator

```
plugins/p-wiki/tools/lib/
├── sync.mjs               ← new: orchestrator (passes 1-4, single direction)
├── cross-links.mjs        ← new: classify / resolve / rewrite (backend-agnostic markdown)
└── destinations/
    ├── fs.mjs             ← + deletePage, + mutatePage(setBody), + pathFor
    └── confluence.mjs     ← + deletePage, + mutatePage(setBody), + pathFor
```

`sync.mjs#syncToMirror(primary, mirror)` is the unit of work. `pwiki sync` calls it once per mirror.

---

## 3. Sync algorithm

```
syncToMirror(src, dst):
  srcPages = src.listPages({ in: 'pages' })      // identity list { type, slug, path }
  dstPages = dst.listPages({ in: 'pages' })
  srcIndex = Map<(type,slug), srcPath>
  dstIndex = Map<(type,slug), dstPath>

  // Pass 1 — write/upsert every source page on the destination, with cross-link hrefs
  // replaced by a sentinel. Pages and properties are created; bodies are well-formed.
  for (type, slug, srcPath) of srcIndex:
    { frontmatter, body } = src.readPage(srcPath)
    bodyStub = stripCrossLinks(body)            // replace href → "#pwiki-pending", keep text
    dst.writePage({ type, slug, frontmatter, body: bodyStub, onConflict: 'overwrite' })

  // Pass 2 — now that all target pages exist, rewrite cross-links in target format.
  for (type, slug, srcPath) of srcIndex:
    dstPath = dst.pathFor({ type, slug })       // synchronous
    { body } = src.readPage(srcPath)
    bodyRewritten = rewriteCrossLinks(body, src, dst)
    dst.mutatePage(dstPath, { setBody: bodyRewritten })

  // Pass 3 — delete pages in dst that are not in src (true mirror).
  for (type, slug, dstPath) of dstIndex:
    if not srcIndex.has((type, slug)):
      dst.deletePage(dstPath)

  // Pass 4 — regenerate Index on dst. The source Index page is NOT copied;
  // dst.regenerateIndex() recomputes it from dst's own listPages.
  dst.regenerateIndex()
```

### 3.1 Why four passes

The naive single-pass approach (write each page with its body in one go) fails on cross-links: when writing page A whose body links to page B, the link's `href` requires B's location on the destination — but B may not exist there yet. Two-phase resolves this:

- **Pass 1** establishes identity-by-identity on the destination (all `(type, slug)` pairs exist with stub bodies). After pass 1, `dst.pathFor({type, slug})` reliably refers to a real page.
- **Pass 2** can now resolve every cross-link to a real target on the destination.

`stripCrossLinks` (rather than just writing the raw source body) ensures partial-failure state is easy to diagnose: `grep pwiki-pending docs/wiki/` (FS) or CQL on `pwiki-pending` (Confluence) shows what didn't complete pass 2. A re-run of `pwiki sync` clears the sentinels — pass 1 overwrites with stubs again, pass 2 finalizes.

### 3.2 Idempotency and resumability

All four passes are idempotent:

- `writePage` with `onConflict: 'overwrite'` is upsert.
- `mutatePage({ setBody })` is overwrite.
- `deletePage` swallows missing-page errors.
- `regenerateIndex` is deterministic.

A `pwiki sync` interrupted mid-run leaves the mirror in some intermediate but well-formed state (every page has at least a stub body). Re-running completes the sync.

### 3.3 Performance

Per mirror: `O(N)` `readPage` calls on source, `2N` writes on destination, plus enumerate + N deletions in the worst case. For Confluence-as-source with hundreds of pages this is slow (one HTTP GET per page); acceptable for a maintenance command run on demand. If hot, a future optimization is `listPages({ withBodies: true })` to batch reads — explicitly out of scope for v3.

---

## 4. Cross-link rewriting

Pages reference each other in the body. Format depends on the backend:

- **FS**: relative markdown links — `[Title](../concepts/foo.md)`.
- **Confluence**: ADF `link` marks whose `href` is `<siteUrl>/wiki/spaces/<key>/pages/<numericId>`. When `readPage` converts ADF → markdown, these become `[Title](<siteUrl>/wiki/spaces/<key>/pages/<numericId>)` in the returned markdown string.

The canonical bridge between the two formats is `(type, slug)` — both destinations key by it.

### 4.1 Algorithm

`rewriteCrossLinks(body, src, dst)` operates on the markdown body returned by `src.readPage`. For each markdown link found (outside fenced/inline code blocks):

1. **Classify** the `href`:
   - Confluence URL matching `<src.siteUrl>/wiki/spaces/<key>/pages/<numericId>` → wiki cross-link.
   - Relative path matching `(\.\./)*(concept|person|source|query)/<slug>\.md` → wiki cross-link.
   - Anything else (external URL, anchor, `mailto:`, etc.) → pass through verbatim.
2. **Resolve to identity** `(type, slug)`:
   - From Confluence URL: extract numeric id → `src.identity.resolveById(numericId)` → `(type, slug)` via the page's `pwiki-id` and `pwiki-type` properties (cached in `confluence/identity.mjs`).
   - From FS path: parse the path under wiki root → `(type, slug)`.
3. **Format for `dst`**:
   - If `dst.kind === 'fs'`: compute the relative path from the current page's FS location to `dst.pathFor({type, slug})`, format as `[Title](<relPath>)`.
   - If `dst.kind === 'confluence'`: look up the numeric id of `(type, slug)` on `dst` (via `dst.identity.resolveByIdentity({type, slug})` — same helper that powers v2 Confluence destination), format as `[Title](<dst.siteUrl>/wiki/spaces/<dst.spaceKey>/pages/<numericId>)`.
4. **Wiki cross-link whose `(type, slug)` does not exist on `dst`**: emit verbatim, log a warning to stderr (`[sync] cross-link target <type>/<slug> not found on mirror <name>`). Lint surfaces the broken link on the mirror later.

### 4.2 `stripCrossLinks`

Pass 1 variant. Same classification as §4.1, but every wiki cross-link's `href` is replaced with the literal string `#pwiki-pending`; link text and surrounding markdown are preserved. External URLs untouched.

### 4.3 Module placement

`cross-links.mjs` is pure-functional, no I/O. Its inputs are `(body: string, src: Destination, dst: Destination)`; it calls only synchronous methods on the destinations (`pathFor`, `siteUrl` accessor, identity caches pre-populated by `listPages` in pass 1). No `readPage` / no HTTP from inside the rewriter.

---

## 5. CLI

### 5.1 `pwiki sync`

No arguments, no flags. Reads `.pwiki.json`, iterates `mirrors`, runs §3 against each.

Output (text mode):

```
Syncing primary=confluence → mirror=fs-backup
  pass 1: writing 47 pages
  pass 2: rewriting cross-links in 47 pages
  pass 3: deleting 2 pages (e2e-old-1, e2e-old-2)
  pass 4: regenerating Index
Done in 18.2s.
```

Output (`--format=json`):

```json
{
  "ok": true,
  "mirrors": [
    {
      "name": "fs-backup",
      "written": 47,
      "rewritten": 47,
      "deleted": 2,
      "indexed": true,
      "warnings": 0,
      "elapsedMs": 18234
    }
  ]
}
```

Exit codes:

- **0** — all mirrors completed.
- **1** — at least one mirror failed (network error, auth error, etc.). `error.code` reports the first failure; `mirrors[].error` reports per-mirror.
- **2** — config invalid (e.g. `primary` name not in `destinations`, mirror name not in `destinations`, `kind` missing on a destination).
- **3** — internal error.

Sync is not transactional. A partial failure leaves the mirror well-formed but possibly incomplete; re-running `pwiki sync` resumes cleanly (per §3.2).

After one mirror fails, sync continues to the remaining mirrors. The final exit code is the worst per-mirror result.

### 5.2 No other CLI changes

All v2 commands continue to work — they dispatch through `resolveDestination(...).primary`. Skills do not change (except the additive init prompt, §6.1).

### 5.3 Future flags (deferred)

Not in v3, listed only so the design space is clear:

- `pwiki sync --to <name>` — sync only the named mirror.
- `pwiki sync --dry-run` — compute and print the three sets (write / rewrite / delete) per mirror without applying. Easy to add post-hoc.

---

## 6. Configuration UX

### 6.1 `pwiki init` — additive prompt

After the v2 init flow has resolved the primary destination, prompt:

> Add a mirror? (y/N)

If `y`, run the destination prompts again for the second backend (FS or Confluence; whichever the user did NOT pick first is the natural offer). Write both into `destinations`, with the first as `primary` and the second as the only entry in `mirrors`. Skip — write the v3-shape config with `mirrors: []`.

Adding or removing mirrors later is a manual `.pwiki.json` edit — documented in the wiki CLAUDE.md template (§6.2).

### 6.2 Editing `.pwiki.json` to add mirrors later

Documented in the "Storage backend" section of `skills/_shared/templates/wiki-claude-md.template.md`:

```
To add a mirror after init:
1. Add an entry to "destinations" with a unique name and the backend config
   (must include "kind": "fs" or "kind": "confluence").
2. Add that name to the "mirrors" array.
3. Run `pwiki sync` to populate it.
```

### 6.3 Reversing direction (promote a mirror to primary)

Swap `primary` and the chosen mirror name in `.pwiki.json`. The next `pwiki sync` overwrites the new mirror with the new primary's state.

Documented as a manual JSON edit. The CLI does not automate it because the user's intent ("which destination is canonical now?") cannot be inferred from any in-tree signal. A dedicated `pwiki promote-mirror <name>` helper is explicitly out of scope (§10).

---

## 7. Skill migration

- **`init` skill** gains the additive prompt described in §6.1. No other changes.
- **CLAUDE.md template** (`wiki-claude-md.template.md`) gets the multi-destination notes (§6.2, §6.3) appended to the existing "Storage backend" section.
- **All other skills** — `ingest`, `compile`, `query`, `lint` — are unchanged. They dispatch through the resolver's `.primary`; mirrors are invisible to them.

A new skill `p-wiki:sync` is **not** added in v3. Sync is a maintenance operation, invoked via the CLI directly or via cron. Wrapping it in a slash command is trivial later if invocation frequency is high.

---

## 8. Testing

Matches the v2 three-layer structure.

### 8.1 Unit (offline)

- `cross-links.mjs`:
  - Classify wiki cross-link vs external URL (Confluence-shape, FS-shape, mailto, anchor, etc.).
  - Extract `(type, slug)` from FS relative path and from Confluence URL.
  - Format target in the other shape; `stripCrossLinks` produces `#pwiki-pending` and preserves text.
  - Skip rules: links inside fenced code blocks, inline code, link text vs href.
- `config.mjs`:
  - v2-shape input → migrated v3-shape, both in returned object and persisted to disk (assert file rewrite happens).
  - v3-shape input → returned as-is, no file rewrite.
  - Neither shape → `config-invalid` error.
  - `kind` missing on a destination → `config-invalid`.
  - Mirror name not in `destinations` → `config-invalid`.
- `destination.mjs#resolveDestination`:
  - Returns `{ primary, mirrors, primaryName, mirrorNames }` correctly populated for v3 configs.
  - Empty `mirrors` array yields `mirrors: []`.
  - Mirror destinations not instantiated until requested (lazy construction asserted by counting HTTP-client constructor calls).

### 8.2 Contract (extend `destination-contract.test.ts`)

Two new methods added to the contract suite, applied to both FS and Confluence backends:

- `deletePage`:
  - Returns `{ deleted: true }` for an existing page; `pageExists` is false afterward.
  - Returns `{ deleted: false }` for a missing page; no error thrown.
- `mutatePage(path, { setBody })`:
  - Changes body bytes; frontmatter (FS) / properties + labels (Confluence) preserved verbatim.
  - On Confluence: page body version bumps by exactly 1; property versions unchanged.

`pathFor` is exercised implicitly by every sync test.

### 8.3 Sync (`tools/__tests__/sync.test.ts`)

Runs the full §3 algorithm using two in-memory backends (FS-against-temp-dir + fake-Confluence from v2 fixtures). Each scenario covers both directions (`fs→confluence` and `confluence→fs`):

- Empty source + empty mirror → no-op (no writes, no deletes).
- Source has 3 pages, mirror empty → mirror gains 3 pages with rewritten cross-links.
- Source removes 1 page → mirror loses 1 page on next sync; remaining pages untouched.
- Source updates 1 page (body + tag) → mirror's copy updates body and labels.
- Mirror has page not in source → deleted on sync.
- Page in source links to another page in source → mirror's copy has cross-link in target format (FS-relative or Confluence-URL).
- Pass 1 failure simulated (writePage rejects on page 2 of 3) → exit 1 with `error.code` set; mirror has page 1 written (sentinel body), pages 2-3 missing; re-run completes successfully.
- Source body contains an external URL and a wiki cross-link → external URL preserved, wiki link rewritten.
- Source body contains a broken wiki cross-link (target page does not exist anywhere) → link preserved verbatim, one warning logged.

### 8.4 E2E (extend `confluence-e2e.test.ts`)

One new scenario after the existing v2 flow:

- Bootstrap: existing Confluence sandbox space + temp FS dir.
- Configure both in `.pwiki.json`: `primary: "confluence"`, `mirrors: ["fs-temp"]`.
- Create two concept pages and a query that links to one of the concepts via the normal `pwiki new` flow.
- Run `pwiki sync`.
- Assert FS mirror has three matching `.md` files with rewritten relative-path cross-links and a regenerated `INDEX.md`.
- Delete one of the source pages via Confluence UI (raw DELETE call from the test).
- Run `pwiki sync` again.
- Assert FS mirror is down to two pages, `INDEX.md` rewritten.

E2E gating unchanged (`PWIKI_E2E_CONFLUENCE=1`, dedicated sandbox space).

---

## 9. Backwards compatibility

- **v2 wikis keep working.** `.pwiki.json` v2-shape is auto-migrated on first read (§2.2) and persisted in v3 shape. No user action required.
- **v1 wikis (no `.pwiki.json`) keep working.** Resolver still defaults to FS via the file-absent rule.
- **Frontmatter schema unchanged.**
- **Skill interfaces unchanged** (except the additive `init` prompt).
- **CLI flags unchanged.** `pwiki sync` is a new command; no existing command is renamed or has flags removed.
- **New runtime requirement** only for multi-destination users: every entry in `destinations` MUST carry an explicit `kind`. Migration of v2 configs adds it automatically.
- **Third-party tooling** that reads `.pwiki.json` directly will see the new shape. This is the breaking-change rationale for v3.0.0; auto-migration makes the impact invisible to humans using only the CLI / skills.

Version bump: **v2.x → v3.0.0** — config shape change is breaking on paper. Per project rules (root `.claude/CLAUDE.md`), a renamed/restructured config field is a major bump.

---

## 10. Out of scope for v3

- **Selective sync** (`--to <name>`, `--types`, `--since`).
- **Bidirectional / multi-source sync.** One primary, N mirrors.
- **Conflict detection on mirrors.** Mirrors are overwritten silently.
- **Continuous / write-through sync.** Sync is a discrete command.
- **Syncing `raw/`, attachments, comments, page history.**
- **`pwiki promote-mirror <name>`** helper to swap primary and mirror programmatically. Documented as a manual JSON edit.
- **`pwiki sync --dry-run`.** Easy to add later; not in v3.
- **Three-or-more-destination convenience features** beyond "iterate every entry in `mirrors`."

If any of these become priorities, each gets its own brainstorming session and design doc.
