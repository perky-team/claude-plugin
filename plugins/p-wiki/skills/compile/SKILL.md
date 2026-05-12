---
name: compile
description: |
  Synthesize wiki pages from a source file. Accepts a path to any file in the repo (raw/ item, design spec, README, ADR, code doc). Without arguments, processes all `raw/**` items with `compiled: false`. Re-running on the same path is idempotent — derived pages get updated, not duplicated. Use when the user says "compile", "synthesize pages", "process the source", or names a doc to extract knowledge from.
argument-hint: "[<path>]"
allowed-tools: Bash(git rev-parse:*) Read Write Edit Grep Glob
---

# /p-wiki:compile

You are synthesizing wiki pages from one or more source files.

`$ARGUMENTS` is either empty or a single path.

## Step 1 — Find the wiki

`<root>` = `git rev-parse --show-toplevel`. Confirm `<root>/docs/wiki/CLAUDE.md` exists; it auto-loads now. If not, stop and ask user to run `/p-wiki:init` first.

## Step 2 — Build the source list

- If `$ARGUMENTS` is a non-empty path: list = [that one path]. Confirm the file exists (Read).
- If `$ARGUMENTS` is empty: glob `<root>/docs/wiki/raw/**/*.md`, then filter to those whose frontmatter has `compiled: false`. List = matches.

If the list is empty, stop with "Nothing to compile."

## Step 3 — Determine kind of each source

For each file in the list, classify:
- **Raw source**: path is under `<root>/docs/wiki/raw/`. Frontmatter follows the raw schema (see `docs/wiki/CLAUDE.md`).
- **In-repo source**: any other path under `<root>/`. No frontmatter expected.

## Step 4 — Process each source

For each source file:

### 4a. Read

Read the whole file. If it has frontmatter, separate it from the body.

### 4b. Extract entities

Identify the substantive entities in the source:
- **Concepts** — ideas, technologies, patterns, algorithms.
- **People** — named individuals (only if the source actually discusses them).
- **(Source-summary)** — only for raw sources, you'll create one of these.

Don't invent entities not in the source.

### 4c. Pick a slug for each entity

Title → normalised title (lowercase, strip punctuation, collapse spaces).

Before treating it as new, **grep `<root>/docs/wiki/pages/<type>/*.md`** for a `title:` whose normalised form matches. If found → reuse that page's id; you'll Edit, not Write.

Else slug = kebab-case(title). If `pages/<type>/<slug>.md` already exists for an unrelated title, suffix with `-YYYY-MM-DD`.

### 4d. Write or Edit each page

For each entity, target path is `<root>/docs/wiki/pages/<type>/<slug>.md`.

If the file doesn't exist:
- Write a new page using the template from `docs/wiki/CLAUDE.md` for that type.
- Frontmatter: `id`, `type`, `title`, `created` = today, `updated` = today, `status: active`, `tags: [...]` extracted from the source, `sources: [<repo-root-relative path to the source>]`. For type `source`, add `source-url`, `source-type`.

If the file exists:
- Edit the body to add new facts in the appropriate sections (Key facts / Main ideas / Related concepts).
- Bump `updated` to today.
- Add the source path to `sources:` if not already there.
- Do not remove existing content.

If two sources disagree on a fact, insert a callout block (see `docs/wiki/CLAUDE.md` compile rules) in both affected pages — never silently overwrite.

Apply [Markdown sanitization](#markdown-sanitization) to all body content before writing.

### 4e. Source-summary (raw sources only)

For raw sources, additionally create `<root>/docs/wiki/pages/source/<source-slug>-summary.md` using the source-summary template. `sources:` is `[<path to the raw file>]`.

Skip this step for in-repo sources — the original is already discoverable in the repo.

### 4f. Backlink audit

For each page created or updated in this pass:

1. Grep all of `<root>/docs/wiki/pages/**/*.md` for the page's exact `title:` (case-sensitive, whole-word match).
2. For each file that mentions the title:
   - Skip if the mention is already inside a markdown link `[...](...)`.
   - Skip if the mention is inside a fenced code block (` ``` … ``` `) or inline code (`` `…` ``).
   - At the first remaining occurrence, replace the bare word with a markdown link to the page (relative path from the editing file).
   - Do this at most once per file per page.

Stop early if a single page would produce more than 20 backlink additions across the wiki — flag it as suspicious in the report and ask the user before proceeding (likely a common-word collision).

### 4g. Stamp the raw frontmatter

If the source was a raw file (not in-repo): Edit its frontmatter — set `compiled: true` and `compiled-to:` to the list of pages just created/updated for it.

Do not touch in-repo source files.

## Step 5 — Regenerate `index.md`

Glob `<root>/docs/wiki/pages/**/*.md`. Group by type, using these exact section headings (matching the template):

- `## Concepts` — pages with `type: concept`
- `## People` — pages with `type: person`
- `## Sources` — pages with `type: source`
- `## Queries` — pages with `type: query`

For each group, list each page as `- [<title>](pages/<type>/<slug>.md) — <one-line summary from frontmatter or first body sentence>`. If a group has no pages, render `_(none yet)_` instead of an empty list. Apply [Markdown sanitization](#markdown-sanitization) to each summary before emitting. Overwrite `<root>/docs/wiki/index.md`.

Keep the header "# Wiki index" and the "regenerated by ... don't edit by hand" note from the template.

## Step 6 — Report

Tell the user:
- N pages created, M updated.
- K backlinks added.
- Any conflict callouts inserted, listed by file.
- Any backlink-audit warnings deferred for human review.

## Markdown sanitization

Applies to every place this skill writes markdown — page bodies, source summaries, and the `index.md` summary lines.

Before writing markdown, wrap bare `<word>`-style tokens (e.g. `<group>`, `<vendor>`, `<tenant>`) in backticks: `` `<group>` ``. A token is "bare" if it is **not** already inside an inline-code span (`` `…` ``) or a fenced code block (` ``` … ``` `). Match pattern: `<` immediately followed by an ASCII letter, then word chars / hyphens, then `>`.

Why: Obsidian and CommonMark parse bare `<word>` as an opening HTML tag and stop rendering subsequent markdown until a matching close tag. In a dense list like `index.md`, one unescaped placeholder cascades to every following entry; in a page body it can swallow paragraphs after the offending line.

## Edge cases

- Source file exists but is empty → skip it and report.
- Source file references entities that share normalised titles with existing pages of a different type → prefer the existing type; do not duplicate across types.
- A page would exceed 2000 words after Edit → flag in the report, suggest splitting (don't auto-split).
