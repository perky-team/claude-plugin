# Sketch: Confluence destination for `pwiki` CLI

**Date:** 2026-05-14
**Status:** Vision / placeholder. **Not implementation-ready.**
**Relation to v1:** Follows `2026-05-14-pwiki-cli-design.md`. Intended for v2 of the plugin (post-v1 ship).

---

## Why this is a sketch, not a spec

Most decisions for the Confluence backend depend on shapes that the v1 implementation will reveal — the actual backend interface, the seam between skills and CLI, the real surface of the schema module, edge cases that emerge in FS-only operation. Writing a detailed v2 spec before those shapes exist is speculative work, likely to be partially rewritten.

This sketch captures what is already decided and what must be decided later. It is a bookmark to be expanded into a full design via a fresh brainstorming session **after v1 is implemented** (or far enough into implementation that the abstractions are concrete).

---

## What is decided

### 1. Use case

The Confluence backend is for teams whose primary knowledge base is Confluence. The local markdown wiki under `docs/wiki/` is not the team's canonical store — Confluence is. The CLI/skills write entirely to Confluence; nothing meaningful sits on disk except configuration.

**Per-installation choice.** A given wiki is either FS-backed or Confluence-backed, never both. The choice is made at `/p-wiki:init` and recorded in `docs/wiki/`. There is no dual-write, no mirroring, no fallback between the two.

### 2. Architecture

CLI knows both backends. Skills do not branch on destination — they call `pwiki <command>` the same way regardless, and the CLI dispatches to the FS backend or the Confluence backend based on configuration.

A `Destination` interface inside the CLI abstracts over both. v1 ships only the FS implementation; v2 adds the Confluence implementation behind the same interface.

```
tools/
├── pwiki.mjs
└── lib/
    ├── destinations/
    │   ├── fs.mjs              ← v1
    │   └── confluence.mjs      ← v2
    ├── destination.mjs         ← interface contract (declared in v1, used by both)
    └── ...
```

### 3. Versioning

Confluence backend is **v2 of the plugin** (`v1.x → v2.0`). It is a major bump because:

- New environment requirement: Atlassian API token, network access.
- New install-time configuration shape (destination type, site URL, space key, parent page ID).
- Changes the contract of `pwiki init` (asks which destination to use).

---

## What needs v1 implementation experience first

These cannot be designed responsibly before v1 ships:

- **Destination interface shape.** What methods does it expose? `createPage`, `updatePage`, `findBySlug`, `search`, `lintInventory`? The exact signatures depend on how v1's `new`/`set`/`promote`/`search`/`lint` decompose internally. Writing the interface now risks coupling v2 to invented v1 internals.
- **Identity mapping seam.** The FS backend identifies pages by path; Confluence identifies by page ID. The CLI surface promises repo-root-relative paths in output. Whether v2 returns Confluence URLs, synthetic paths, or both — depends on how skills consume the v1 output.
- **Error semantics.** v1 has exit codes 0/1/2/3 mapped to FS-flavored failures (file not found, slug taken). Confluence brings new failure classes (auth, rate-limit, version-conflict from concurrent edits, network timeout). The mapping needs to be re-examined when we know how the v1 codes are actually used by skills.
- **Lint check semantics.** v1 lint includes dead-links (resolved against filesystem), orphan pages, frontmatter validation, underlinked, stale. Confluence equivalents exist but mean different things (`dead-links` might mean broken internal page references; `orphan` requires CQL or graph walking). The clean form of these checks is clearer when we see v1 in action.

---

## Open questions to resolve in the v2 brainstorming session

When v1 is in implementation, restart brainstorming for v2. The questions to answer:

### Auth and connectivity

- Atlassian Cloud only, or also Server / Data Center? (Cloud is dominant; Server has different APIs.)
- Where does the API token live? Environment variable, OS keychain, config file in repo (excluded from git), Claude Code secret?
- How does `init` discover the user's Confluence site and space? Interactive prompt, env var, both?

### Content format

- Markdown → ADF (modern, JSON), or markdown → Confluence storage format (XHTML-flavored)?
- Which converter? Hand-rolled (small subset of markdown, narrow features), `marked` + custom renderer, or pull in an existing converter as a vendored dep?
- Round-trip fidelity: when reading a page back from Confluence (for `set` to mutate it), do we preserve user edits that happened in Confluence's UI?

### Identity and hierarchy

- How are pages identified across the boundary? Page properties carrying `pwiki-id`, labels of the form `pwiki-id-<id>`, or both?
- Where does the `pwiki` content sit in the Confluence tree? Under a single configured parent page? Nested by type (Concepts / People / Sources / Queries as sub-parents)? Flat?
- Slug uniqueness: in FS, slug is unique within a type-directory. In Confluence, title is unique within a parent. Do we require both?

### Raw sources

- Where do `raw-article`, `raw-file`, `raw-paste` live in Confluence? As pages under a `Raw/` parent? As attachments on a stub page? Outside Confluence entirely (still on FS in `docs/wiki/raw/`)?
- File attachments (PDFs, transcripts) are first-class in Confluence and don't fit the page model cleanly. They probably stay as attachments on a host page.

### Search

- v1 has BM25-lite over body text. v2 over Confluence: use CQL (`text ~ "..."`) and trust Confluence's ranking? Add post-rerank in CLI? Keep BM25-lite by fetching candidate page bodies?
- Search latency budget: CQL + page fetches per result are slow. Acceptable for skill workflows?

### Dependencies

- v1 is zero npm deps. Adding Confluence likely requires at least: markdown→ADF/storage converter, possibly a CQL builder.
- Vendor (copy minified source into `tools/lib/vendor/`)? Add a real `package.json` with deps and document a `npm install` step at plugin install? Use Node's built-in HTTP only and write the converter by hand?

### Lint adaptation

- Which v1 lint checks port directly, which need new semantics, which become impossible (or trivially zero) in Confluence?
- New Confluence-only checks worth adding: pages with missing `pwiki-id` (drift / hand-created), pages whose `pwiki-type` doesn't match their parent's expected type.

### Migration path

- A user who started with FS v1 and wants to switch to Confluence — do we ship a one-shot `pwiki migrate` command? Out of scope for v2 or in scope?

---

## Constraint for v1 design

This sketch implies one explicit constraint on the v1 CLI:

> The internal `Destination` interface (even if only FS is implemented) **should be defined** in v1, with the FS backend conforming to it. The CLI entry point dispatches through it. This is the only architectural concession v1 must make for v2 to remain feasible without rewriting the CLI entry.

If v1 conflates `new`/`set`/`promote`/`search`/`lint` with FS-specific code throughout, v2 becomes a rewrite, not an addition. A single seam — the destination interface — keeps v2 additive.

This is small enough to fold into v1 without scope creep: a `tools/lib/destination.mjs` declaring the interface shape, plus `tools/lib/destinations/fs.mjs` containing the FS implementation, plus the dispatch in `pwiki.mjs`. No HTTP, no Confluence code, no auth — just the seam.

This constraint has been folded into the v1 spec — see §2.6 of `2026-05-14-pwiki-cli-design.md`.
