# Wiki rules and schemas

This file is auto-loaded by Claude Code whenever it reads files under `docs/wiki/`. It defines the schemas, naming rules, link rules, and compile rules every skill in plugin `x-wiki` follows.

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
status: filed             # filed | promoted
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
- A concept page must have ≥3 outgoing links to other pages (enforced by `/x-wiki:lint`; `status: draft` exempt).
- **Backlink audit during compile is mandatory.**
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
