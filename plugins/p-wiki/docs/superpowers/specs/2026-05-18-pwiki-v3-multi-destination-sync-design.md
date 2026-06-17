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
      "kind": "fs"
    }
  }
}
```

Field semantics:

- `primary` (required, string) — name (= key in `destinations`) of the canonical destination. Every non-sync CLI command operates on `destinations[primary]`.
- `mirrors` (optional, array of strings) — zero or more names that receive a 1:1 copy of the primary on every `pwiki sync`. Each name MUST also key into `destinations`. Defaults to `[]`.
- `destinations` (required object) — map keyed by user-chosen name. Each value is the per-backend config plus an explicit `kind` discriminator (`"fs"` or `"confluence"`). The key is just an identifier — `kind` is authoritative. Multiple instances of the same kind are allowed (e.g. two `confluence` instances pointing at different spaces, distinguished by name).

Default (file absent): treat as `{ primary: "fs", mirrors: [], destinations: { fs: { kind: "fs" } } }`. Preserves v1 behavior. The FS destination always lives at `<repoRoot>/docs/wiki/`; no `path` field — multi-path FS support is out of scope for v3 (a Confluence-primary + FS-mirror setup writes to the single `docs/wiki/` location, which is empty when Confluence is canonical).

### 2.2 Migration of v2 config

On every read of `.pwiki.json`, `config.mjs#readConfig` detects shape:

1. **v3 shape** (`primary` field present) → use as-is.
2. **v2 shape** (`destination` field present, no `primary`) → rewrite in memory to:
   ```js
   {
     primary: old.destination,                                  // "fs" or "confluence"
     mirrors: [],
     destinations: {
       [old.destination]: old.destination === 'fs'
         ? { kind: 'fs' }
         : { kind: 'confluence', ...old.confluence }            // v2 nests confluence block
     }
   }
   ```
   In practice, `.pwiki.json` only ever existed in v2 with `destination: 'confluence'` (v2 omits the file for FS wikis — see v2 §2.4). The `destination: 'fs'` branch handles users who manually wrote an explicit FS config. **Persist immediately** — overwrite the file with the v3 shape. Migration is lossless and one-shot.
3. **Neither** → exit 1 with `error.code = config-invalid`, message names the missing/unexpected fields.

A user who never runs a CLI command after upgrade keeps a working wiki — the next CLI invocation does the in-place migration.

### 2.3 Resolver and destination factories

`tools/lib/destination.mjs#resolveDestination(env)` returns:

```
{
  primary: Destination,
  primaryName: string,
  mirrors: Destination[],         // possibly empty, parallel to mirrorNames
  mirrorNames: string[]
}
```

Today the resolver returns a single `Destination` directly. The seven call sites in `tools/pwiki.mjs` (each named `dest = resolveDestination(...)`) become `dest = resolveDestination(...).primary`. The two `destination-resolve.test.ts` cases also update. Only `pwiki sync` reads `.mirrors`.

Mirror destinations are constructed lazily — `mirrors[i]` is built only if `pwiki sync` actually iterates over it. (Construction can be expensive for Confluence: env-var checks, HTTP-client setup.)

**Factory signature change.** The current `createConfluenceDestination({ root, config, transport })` reaches into `config.confluence.siteUrl` etc. In v3 it accepts a single per-destination block:

```
createConfluenceDestination({ root, destinationConfig, transport })
   // destinationConfig: { kind:'confluence', siteUrl, spaceKey, spaceId, rootPageId, subParents }

createFsDestination({ root, destinationConfig })
   // destinationConfig: { kind:'fs' }                     — no other fields in v3
   // root: repo root (unchanged semantics — FS lives at <root>/docs/wiki/)
```

The resolver builds the per-destination config block from `cfg.destinations[name]` and passes it through. This isolates the v2→v3 schema change to `config.mjs` and `destination.mjs`; the destination implementations stay otherwise unchanged.

### 2.4 Destination interface additions

Four additions to the `Destination` contract:

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
- FS impl: `join(rootPath, 'docs/wiki/pages', directoryFor(type), `${slug}.md`)`, POSIX-normalized via `toRepoRelative`.
- Confluence impl: `confluence://<type>/<slug>`.

Used by sync to derive destination paths without round-tripping `pageExists`.

```
ensureStructure() → void                   // idempotent, possibly async
```

- Brings the destination up to a state where `writePage({type, slug, ...})` is safe for every `type` in the schema. Bootstraps backend-specific scaffolding that v2's `pwiki init` would otherwise have done.
- FS impl: no-op — `writePage` already does `mkdirSync({recursive: true})`.
- Confluence impl: for each type in `['concept','person','source','query']`, call `tree.mjs#ensureSubParent(http, spaceId, rootPageId, type)` and update the destination's in-memory `subParents` map. Idempotent — re-running finds existing sub-parents via `pwiki-role` lookup.
- Called by sync at the start of every per-mirror run, so a Confluence destination added as a mirror via a hand-edited `.pwiki.json` (no init invocation) still works.

```
parseWikiLink(href, fromPath) → { type, slug } | null
formatWikiLink({ type, slug }, fromPath) → string
```

- `parseWikiLink`: returns identity if `href` (markdown link target) points to a wiki page on THIS destination, treating relative paths as resolved against `fromPath`. Returns `null` for external URLs, anchors, mailto, or wiki cross-links whose `(type, slug)` is unresolvable on this destination.
  - FS impl: resolve `href` relative to `fromPath`, normalize, check if absolute path matches `docs/wiki/pages/<directoryFor(type)>/<slug>.md`; return `{type, slug}` or null. Handles `./bar.md`, `bar.md`, `../source/baz.md` uniformly.
  - Confluence impl: match against `<this.siteUrl>/wiki/spaces/<this.spaceKey>/pages/<numericId>`; on match, look up `(type, slug)` from `identity.resolveById(numericId)` (cache, no HTTP if hot); return null for foreign siteUrls.
- `formatWikiLink`: returns a markdown link `href` pointing to `(type, slug)` on THIS destination, suitable for inclusion in the body of `fromPath` (relativity needs the source-page context).
  - FS impl: compute relative POSIX path from `dirname(fromPath)` to `pathFor({type, slug})`.
  - Confluence impl: look up the numeric id of `(type, slug)` on this destination, return `<this.siteUrl>/wiki/spaces/<this.spaceKey>/pages/<numericId>`. If identity is not in cache, fall back to one CQL lookup; on miss, throws (cross-link rewriter handles the throw as "broken link, leave verbatim, warn").

These two methods are the seam that lets `cross-links.mjs` stay backend-agnostic — it never sees `siteUrl`, never sees `pwiki-id` properties, never touches the Confluence URL format directly.

### 2.5 `mutatePage` body extension

v2 `mutatePage` accepts property/tag mutations only. v3 adds one more mutation shape for pass 2 of sync:

```
mutatePage(path, { setBody: string })
```

- FS impl: rewrite the file body in place, frontmatter preserved verbatim.
- Confluence impl: `markdownToAdf(body)` → GET current page version → PUT new ADF body with `version.number = current + 1`. Properties untouched. Auto-retry on 409 per v2 §5.3.

Additive: existing mutation shapes (`addTag`, `removeTag`, `set: {...}`) are unchanged. The v2 invariant — *"`mutatePage` does not touch body when no body mutation is in the mutations object"* — is preserved; the body GET / PUT path runs only when `setBody` is present in the mutations argument.

Sync calls `mutatePage(dstPath, { setBody: bodyRewritten })` with no other mutations, so cross-link rewriting bumps the body version by exactly 1 per page per sync run.

### 2.6 Sync orchestrator

```
plugins/p-wiki/tools/lib/
├── sync.mjs               ← new: orchestrator (pass 0..4, single direction)
├── cross-links.mjs        ← new: classify / resolve / rewrite (backend-agnostic markdown)
└── destinations/
    ├── fs.mjs             ← + deletePage, + mutatePage(setBody), + pathFor,
    │                        + ensureStructure, + parseWikiLink, + formatWikiLink
    └── confluence.mjs     ← + deletePage, + mutatePage(setBody), + pathFor,
                             + ensureStructure, + parseWikiLink, + formatWikiLink
```

`sync.mjs#syncToMirror(primary, mirror)` is the unit of work. `pwiki sync` calls it once per mirror.

---

## 3. Sync algorithm

`listPages` returns `{ path, frontmatter }[]` per the v2 interface (see `tools/lib/destination.mjs`). Identity `(type, slug)` is derived as `(frontmatter.type, frontmatter.id)` — `frontmatter.id` is the canonical slug (FS `writePage` sets `fm.id = useSlug`; Confluence stores the same as `pwiki-id`).

```
syncToMirror(src, dst):
  // Pass 0 — make dst capable of receiving writes for every type.
  dst.ensureStructure()                            // no-op for FS; bootstraps sub-parents for Confluence

  // Enumerate once. Read source bodies once and hold them in memory across passes.
  srcList = src.listPages({ in: 'pages' })         // [{path, frontmatter}]
  dstList = dst.listPages({ in: 'pages' })

  srcIndex = new Map()                             // key: "<type>/<slug>", value: { srcPath, frontmatter, body }
  for ({ path: srcPath, frontmatter } of srcList):
    { body } = src.readPage(srcPath)               // one read per source page total
    srcIndex.set(`${frontmatter.type}/${frontmatter.id}`, { srcPath, frontmatter, body })

  dstIndex = new Map()                             // key: "<type>/<slug>", value: dstPath
  for ({ path: dstPath, frontmatter } of dstList):
    dstIndex.set(`${frontmatter.type}/${frontmatter.id}`, dstPath)

  // Pass 1 — write/upsert every source page on dst with cross-link hrefs
  // replaced by a sentinel. Pages and properties are created; bodies are well-formed.
  for ([key, { srcPath, frontmatter, body }] of srcIndex):
    bodyStub = stripCrossLinks(body, src, srcPath) // replace wiki-link hrefs → "#pwiki-pending"
    dst.writePage({
      type: frontmatter.type,
      slug: frontmatter.id,
      frontmatter,
      body: bodyStub,
      onConflict: 'overwrite',
    })

  // Pass 2 — rewrite cross-links in target format now that all dst pages exist.
  for ([key, { srcPath, frontmatter, body }] of srcIndex):
    dstPath = dst.pathFor({ type: frontmatter.type, slug: frontmatter.id })  // synchronous
    bodyRewritten = rewriteCrossLinks(body, src, srcPath, dst, dstPath)
    dst.mutatePage(dstPath, { setBody: bodyRewritten })

  // Pass 3 — delete pages in dst that are not in src (true mirror).
  for ([key, dstPath] of dstIndex):
    if not srcIndex.has(key):
      dst.deletePage(dstPath)

  // Pass 4 — regenerate Index on dst. The source Index page is NOT copied;
  // dst.regenerateIndex() recomputes it from dst's own listPages.
  dst.regenerateIndex()
```

### 3.1 Why pre-pass + four passes

- **Pass 0** (`ensureStructure`) lets a destination be added as a mirror via a hand-edited `.pwiki.json` without prior `pwiki init`. For Confluence, this creates sub-parents on demand; for FS, it's a no-op.
- The naive single-pass approach (write each page with its body in one go) fails on cross-links: when writing page A whose body links to page B, the link's `href` requires B's location on the destination — but B may not exist there yet. Two phases resolve this:
  - **Pass 1** establishes identity on the destination (all `(type, slug)` pairs exist with stub bodies). After pass 1, `dst.pathFor({type, slug})` reliably refers to a real page; for Confluence, `dst.identity` is populated as a side-effect of `writePage`.
  - **Pass 2** can now resolve every cross-link target to a real page on the destination via `dst.formatWikiLink(...)`.
- **Pass 3** deletes mirror-only pages (true mirror semantics).
- **Pass 4** regenerates the Index on the destination — never copied from source, always recomputed.

`stripCrossLinks` (rather than writing raw source bodies in pass 1) ensures partial-failure state is easy to diagnose: `grep pwiki-pending docs/wiki/` (FS) or CQL on `pwiki-pending` (Confluence) shows pages that didn't complete pass 2. A re-run of `pwiki sync` clears the sentinels — pass 1 overwrites with stubs again, pass 2 finalizes.

### 3.2 Idempotency and resumability

All passes are idempotent:

- `ensureStructure` is find-or-create per sub-parent.
- `writePage` with `onConflict: 'overwrite'` is upsert.
- `mutatePage({ setBody })` is overwrite.
- `deletePage` swallows missing-page errors.
- `regenerateIndex` is deterministic.

A `pwiki sync` interrupted mid-run leaves the mirror in some intermediate but well-formed state (every page written so far has at least a stub body). Re-running completes the sync.

### 3.3 Performance and memory

Per mirror: `O(N)` `readPage` calls on source (one per page total — bodies are cached in memory between passes 1 and 2), `2N` writes on destination, plus enumerate + up to `N` deletions in the worst case. For Confluence-as-source with hundreds of pages this is the minimum possible network cost without a `listPages({withBodies: true})` batch API.

Memory: `srcIndex` holds frontmatter + body for every source page. At ~10 KB per page, even 5000 pages is ~50 MB — fine for a maintenance command running in a fresh Node process. If a corpus ever exceeds this, the orchestrator can spill bodies to a temp file between passes — explicitly out of scope for v3.

---

## 4. Cross-link rewriting

Pages reference each other in the body. Format depends on the backend:

- **FS**: relative markdown links — `[Title](../source/baz.md)`, `[Title](./bar.md)`, `[Title](bar.md)`.
- **Confluence**: ADF `link` marks whose `href` is `<siteUrl>/wiki/spaces/<key>/pages/<numericId>`. When `readPage` converts ADF → markdown, these become `[Title](<siteUrl>/wiki/spaces/<key>/pages/<numericId>)` in the returned markdown string.

The canonical bridge between formats is `(type, slug)`. The Destination-interface methods `parseWikiLink` and `formatWikiLink` (§2.4) hide all backend-specific URL/path handling behind a uniform contract.

### 4.1 Algorithm

`rewriteCrossLinks(body, src, srcPath, dst, dstPath)` walks markdown links in `body` (outside fenced/inline code blocks and shortcut reference links — same skip-rules as v1.1 `backlinks.mjs#findSkippedRanges`). For each link `[text](href)`:

1. `id = src.parseWikiLink(href, srcPath)` — classify and resolve to identity.
2. If `id === null`: external URL / anchor / mailto / foreign-site URL → pass through verbatim.
3. Else: replace `href` with `dst.formatWikiLink(id, dstPath)`. The new href is in target format (relative `.md` path for FS, Confluence URL for Confluence).
4. If `formatWikiLink` throws (target page does not exist on `dst`, e.g. broken source link or src/dst out of sync mid-sync): emit verbatim, log a warning to stderr (`[sync] cross-link target <type>/<slug> not found on mirror <name>`). The warning increments the per-mirror `warnings` counter in the JSON output (§5.1). Lint surfaces the broken link separately on the mirror.

### 4.2 `stripCrossLinks`

Pass 1 variant. Same per-link walk, same skip-rules, same classification:

1. `id = src.parseWikiLink(href, srcPath)`.
2. If `id === null`: pass through (external links survive intact).
3. Else: replace `href` with the literal `#pwiki-pending`, keep `text` and surrounding markdown.

This guarantees `markdownToAdf` produces valid ADF (anchor-only hrefs are well-formed link marks), and pass-1 `writePage` does not need any dst-side identity lookups.

### 4.3 Module placement and purity

`cross-links.mjs` is pure-functional (no I/O of its own). Its inputs are `(body, src, srcPath, dst, dstPath)`; it calls only the `parseWikiLink` / `formatWikiLink` methods on the destinations. No `siteUrl` accessor, no `identity` member, no `readPage`, no HTTP. All backend-specific URL/path shapes live in the destination implementations.

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

**CLI subcommand changes.** v2's `pwiki init --confluence --site=... --space=... --parent=...` (Task 29 of the v2 plan) writes the v2 config shape directly. v3 changes this to write the v3 shape — the existing flags still resolve a single Confluence destination, but it is persisted as `{ primary: 'confluence', mirrors: [], destinations: { confluence: { kind: 'confluence', ... } } }`. A new flag `pwiki init --mirror-fs` appends `{ kind: 'fs' }` to `destinations` under the name `fs` and adds it to `mirrors`. The analogous `--mirror-confluence --mirror-site=... --mirror-space=... --mirror-parent=...` adds a Confluence mirror under the name `confluence-mirror`. The init skill prompt at §6.1 wraps these flags. The FS-primary `init` branch (`--mirror-confluence` without `--confluence`) is implemented as of the 2026-06-16 fix — see `2026-06-16-pwiki-init-fs-primary-confluence-mirror-fix.md`.

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

> **Revisited 2026-06-17.** This decision is reversed — the `p-wiki:sync` skill is now added as a thin wrapper over the `pwiki sync` CLI command. See `docs/superpowers/specs/2026-06-17-pwiki-sync-skill-design.md` and the accompanying plan. The skill adds pre-flight checks and a readable summary only; all sync logic stays in the CLI.

---

## 8. Testing

Matches the v2 three-layer structure.

### 8.1 Unit (offline)

- `cross-links.mjs`:
  - Walks links using v1.1 `findSkippedRanges` (fenced/inline code blocks, bracket forms) — assert links inside those ranges are not rewritten.
  - `rewriteCrossLinks` with both `src` and `dst` mocked: `src.parseWikiLink` returns identity for wiki hrefs, null for externals; `dst.formatWikiLink` returns the expected target string; mailto / anchor / external URL pass through verbatim.
  - `formatWikiLink` throws → cross-link emitted verbatim, warning callback invoked once.
  - `stripCrossLinks`: wiki hrefs become `#pwiki-pending`, externals untouched, link text preserved.
- Destination-specific `parseWikiLink` / `formatWikiLink`:
  - FS impl: `parseWikiLink('./bar.md', 'docs/wiki/pages/concept/foo.md')` → `{type:'concept', slug:'bar'}`; `../source/baz.md` → `{type:'source', slug:'baz'}`; `https://example.com` → `null`; `bar.md` → `{type:'concept', slug:'bar'}`.
  - FS impl `formatWikiLink({type:'source', slug:'baz'}, 'docs/wiki/pages/concept/foo.md')` → `../source/baz.md` (POSIX, exact).
  - Confluence impl: parse `<siteUrl>/wiki/spaces/<KEY>/pages/<id>` → identity (with cached pwiki-id lookup); foreign siteUrl → null. Format identity → URL with this destination's siteUrl + numeric id from identity cache; missing identity → throw.
- `ensureStructure`:
  - FS impl: no-op (assertion: directories not created if not needed).
  - Confluence impl (against fake transport): calls `ensureSubParent` for each of the four types; idempotent on second invocation (no extra POSTs).
- `config.mjs`:
  - v2-shape input → migrated v3-shape, both in returned object and persisted to disk (assert file rewrite happens, file content matches expected v3 JSON).
  - v3-shape input → returned as-is, file mtime unchanged.
  - Neither shape → `config-invalid` error with code in JSON output.
  - `kind` missing on a destination → `config-invalid`.
  - Mirror name not in `destinations` → `config-invalid`.
  - `primary` name not in `destinations` → `config-invalid`.
- `destination.mjs#resolveDestination`:
  - Returns `{ primary, mirrors, primaryName, mirrorNames }` correctly populated for v3 configs.
  - File-absent → `primaryName === 'fs'`, `primary.kind === 'fs'`, `mirrors.length === 0`.
  - Empty `mirrors` array in config yields `mirrors.length === 0`.
  - Mirror destinations not instantiated until requested (lazy construction asserted by counting factory invocations via a spy).

### 8.2 Contract (extend `destination-contract.test.ts`)

Four new methods added to the contract suite, applied to both FS and Confluence backends:

- `deletePage`:
  - Returns `{ deleted: true }` for an existing page; `pageExists` is false afterward.
  - Returns `{ deleted: false }` for a missing page; no error thrown.
- `mutatePage(path, { setBody })`:
  - Changes body bytes; frontmatter (FS) / properties + labels (Confluence) preserved verbatim.
  - On Confluence: page body version bumps by exactly 1; property versions unchanged.
- `pathFor({type, slug})`:
  - Synchronous, deterministic, no I/O.
  - Output matches what `writePage` returns as `path` for the same `(type, slug)`.
- `ensureStructure`:
  - First call brings the destination into a writable state (assert a subsequent `writePage` for each type succeeds without prior `pwiki init`).
  - Second call is a no-op (no new pages created, no errors).

`parseWikiLink` and `formatWikiLink` are tested in §8.1 (unit) rather than the destination-contract suite, because their semantics differ across backends in interpretable ways (FS shapes vs Confluence URLs) — contract assertions would be vacuous.

### 8.3 Sync (`tools/__tests__/sync.test.ts`)

Runs the full §3 algorithm using two in-memory backends (FS-against-temp-dir + fake-Confluence from v2 fixtures). Each scenario covers both directions (`fs→confluence` and `confluence→fs`):

- Empty source + empty mirror → no page writes, no deletes; pass 4 still runs (regenerateIndex produces an empty Index).
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

- Bootstrap: existing Confluence sandbox space + temp wiki root (the FS mirror writes into `<tempRoot>/docs/wiki/`).
- Configure both in `<tempRoot>/docs/wiki/.pwiki.json`: `primary: "confluence"`, `mirrors: ["fs"]`, both destinations present in `destinations`.
- Create two concept pages and a query that links to one of the concepts via the normal `pwiki new` flow (writes go to Confluence — the primary).
- Run `pwiki sync`.
- Assert FS mirror has three matching `.md` files under `<tempRoot>/docs/wiki/pages/<type>/` with rewritten relative-path cross-links, and a regenerated `<tempRoot>/docs/wiki/index.md`.
- Delete one of the source pages via Confluence UI (raw DELETE call from the test).
- Run `pwiki sync` again.
- Assert FS mirror is down to two pages, `index.md` rewritten.

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
