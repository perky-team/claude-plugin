# Wiki rules and schemas

This file is auto-loaded by Claude Code whenever it reads files under `docs/wiki/`. It defines the schemas, naming rules, link rules, and compile rules every skill in plugin `p-wiki` follows.

## Frontmatter

### Base fields (all 4 page types)

```yaml
id: <slug>                # = filename without .md
type: concept             # concept | person | source | query
title: <human-readable>
created: 2026-05-11       # ISO 8601
updated: 2026-05-11
status: active            # active | stale | draft
tags: [topic1, topic2]
sources: []               # paths the page depends on; ALWAYS relative to repo root. May live in docs/wiki/raw/ or anywhere else in the repo.
```

- `concept` — no extra fields.
- `person` — no extra fields.

### `source`

```yaml
source-url: https://...
source-type: article      # article | paper | transcript | code | doc
```

### `query`

```yaml
question: "<verbatim original>"
informed-by:
  - pages/concept/foo.md
status: filed             # only value; promotion mutates type to concept
```

(base: only `id`, `type`, `title`, `created`, `status`, `tags`)

### Raw files (in `raw/`)

```yaml
id: <slug>
type: raw-article | raw-file | raw-paste
title: <extracted>
source-url: <url|null>
source-type: article | paper | transcript | code | doc
ingested: 2026-05-11
compiled: false
compiled-to: []
```

In-repo files used as sources are NOT modified by the plugin. They appear in `sources:` arrays of pages by their repo-root-relative path.

## Naming

- Slug = kebab-case, ASCII or transliterated, 1–50 chars.
- Conflict → suffix with date: `pods.md` taken → `pods-2026-05-11.md`.
- Query pages: always `<date>-<slug>.md`.
- The subdirectory holds pages of the corresponding `type`: `concept/` → `type: concept`, `person/` → `type: person`, `source/` → `type: source`, `queries/` → `type: query`. Any other combination is a lint error.

## Link rules

- Plain markdown `[text](relative/path.md)`. No `[[wikilinks]]`.
- Paths relative to the file containing the link.
- A concept page must have ≥3 outgoing links to other pages (enforced by `/p-wiki:lint`; `status: draft` exempt).
- **Backlink audit during compile is mandatory** — performed via `pwiki backlinks <path>` for each created/updated page.
- **Index regeneration during compile is mandatory** — performed via `pwiki index` at the end of compile.
- Links to `raw/` are allowed only in the `sources:` frontmatter field, never in body text.

## Compile rules

- **No invention.** Every claim must trace back to a source listed in `sources:`. If a source does not support a claim, leave it out.
- Concept page length: 800–2000 words. Larger → split into sub-pages and link.
- Source-summary length: 300–600 words.
- Factual conflicts between sources — do not silently overwrite. Insert a callout block in both affected pages:
  ```
  > ⚠️ Conflict: [source A](../source/a-summary.md) claims X. [source B](../source/b-summary.md) claims Y.
  ```
- Update vs create: if a page with the same id exists → Edit (don't recreate, don't duplicate).
- Slug stability: before creating a new page, normalise the candidate title (lowercase, strip punctuation, collapse spaces) and check `pages/<type>/*` for an existing page whose normalised title matches. Match → Edit it; no match → Write new.
- Backlink audit safety: (a) case-sensitive whole-word match against the exact `title:` from frontmatter, (b) skip occurrences already inside a markdown link or inside a fenced/inline code block, (c) link only at the first qualifying occurrence per file.

## Page body templates (recommended, not strict)

### Concept / person

````markdown
---
<frontmatter>
---

# <Title>

Definition in 1–2 sentences.

## Key facts
- fact 1 (from [source-summary](../source/foo-summary.md))
- fact 2

## Related concepts
- [Related A](./related-a.md) — short context of the relation
- [Related B](../person/related-b.md)

## Sources
See `sources:` in frontmatter.
````

### Source-summary

````markdown
---
<frontmatter — base fields + source-url, source-type>
---

# Summary: <Original title>

**Original:** [<url>](<url>) · *<source-type>*

## Main ideas
- idea 1
- idea 2

## Extracted concepts
- [Concept A](../concept/a.md)
- [Person X](../person/x.md)
````

### Query output

````markdown
---
<frontmatter — id, type=query, title, created, status, tags, question, informed-by>
---

# <Title>

**Q:** <question verbatim>

**A:** <short answer, 1–3 paragraphs>

## Based on
- [Concept A](../concept/a.md) — what was used
- [Source B summary](../source/b-summary.md)
````

## CLI tool

A bundled Node CLI `pwiki` lives in the plugin (`${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs`). Skills use it for mechanical operations; you should prefer it over generic Read/Write/Grep for:

- **Creating any new page** — `pwiki new <type> --title=... [--source=... --tags=...]` (handles slug, frontmatter, conflicts).
- **Mutating frontmatter** — `pwiki set <path> --bump-updated --add-source=... --add-tag=...`.
- **Promoting query → concept** — `pwiki promote <path> --to=concept`.
- **Ranked search** — `pwiki search "<question>" --format=json --limit=10`.
- **Lint** — `pwiki lint` (text) or `pwiki lint --format=json`.
- **Backlink audit** — `pwiki backlinks <path>` (inserts hyperlinks to `<path>` in other pages where its `title:` is mentioned; exit 2 if the count exceeds the suspicion threshold).
- **Index regeneration** — `pwiki index` (rewrites `docs/wiki/index.md` from frontmatter; `--format=text` prints to stdout without writing).

Generic Read/Write/Edit remain for **body editing** in skills (adding facts to sections, synthesizing answers, conflict callouts). The CLI touches body text only in two specific deterministic operations: rendering the template body of a new page (`pwiki new`) and inserting backlink hyperlinks (`pwiki backlinks`).

All CLI commands accept `--format=json` for machine-parseable output. Exit codes: 0 success, 1 user/env error, 2 conflict/schema violation (JSON body carries detail), 3 internal CLI bug.

Requires Node 18+ in `PATH`.

## Storage backend

This wiki can be stored on the filesystem (default — `docs/wiki/`) or in Confluence Cloud. The choice is made at `init` time and recorded in `docs/wiki/.pwiki.json`. Skills do not branch on backend; the CLI dispatches transparently.

In Confluence mode:

- Page identity in CLI input/output and in `sources:` cross-references is `confluence://<type>/<slug>` (opaque, stable across UI title renames).
- Body cross-references between pages are real Confluence URLs (`<siteUrl>/wiki/spaces/<key>/pages/<numericId>`) so they render as clickable links in Confluence UI.
- `sources:` paths still point to FS files (raw sources remain on disk in both modes).
- Required env vars: `PWIKI_CONFLUENCE_EMAIL` (Atlassian account email) and `PWIKI_CONFLUENCE_TOKEN` (API token from https://id.atlassian.com/manage-profile/security/api-tokens).
- Pages live under the configured `rootPageId`, organized by sub-parents (Concepts, People, Sources, Queries) plus an Index page regenerated by `pwiki index`.
