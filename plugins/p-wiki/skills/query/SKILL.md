---
name: query
description: |
  Answer a question using the wiki's pages, with citations. Writes the answer to `pages/queries/<date>-<slug>.md` and conversationally offers to promote it to a concept page. Use when the user says "query wiki", "ask the wiki", "what does the wiki say about X", or asks a question that might be covered by accumulated project knowledge.
argument-hint: "<question>"
allowed-tools: Bash(git rev-parse:*) Bash(mv:*) Read Write Edit Grep Glob
---

# /p-wiki:query

You are answering one question using the wiki's pages and saving the answer.

`$ARGUMENTS` is the verbatim question.

## Step 1 — Find the wiki

`<root>` = `git rev-parse --show-toplevel`. Confirm `<root>/docs/wiki/CLAUDE.md` exists. If not, stop with "run `/p-wiki:init` first".

## Step 2 — Extract terms

Identify 3–8 keyword terms from the question that are likely to appear in page bodies or titles. Strip stopwords. Include synonyms only if you're confident.

## Step 3 — Search

- For each term, grep `<root>/docs/wiki/pages/**/*.md` case-insensitively.
- Also glob pages whose frontmatter `tags:` overlap with question topics (use Grep with a pattern that matches `tags:.*<topic>`).
- Aggregate matched files, deduplicate, rank by occurrence count.

If aggregate is empty, stop. Tell the user: "Nothing in the wiki covers that. Try ingesting a source first." Do not write a query page in this case.

## Step 4 — Read top results

Read the top 5–10 ranked files in full. If you exceed 10 candidates, pick the top 10 by occurrence count; cite only files you actually read.

## Step 5 — Synthesize the answer

Compose a 1–3 paragraph answer. Cite specific pages inline using markdown links: `[Title](pages/concept/foo.md)`. Never claim something the cited pages don't support; if the wiki is silent or contradictory on a point, say so.

## Step 6 — Write the query-output page

Path: `<root>/docs/wiki/pages/queries/<YYYY-MM-DD>-<question-slug>.md`.

Slug from a 3–6 word condensation of the question, kebab-case.

Frontmatter (see `docs/wiki/CLAUDE.md`, query schema):
```yaml
id: <YYYY-MM-DD>-<slug>
type: query
title: <human-readable short form>
created: <today ISO>
status: filed
tags: [<topics>]
question: "<verbatim original question>"
informed-by:
  - <relative path to each cited page>
```

Body: the answer composed in Step 5.

## Step 7 — Reply and invite promotion

Return the answer to the user in chat. End your reply with one short line like:

> "Saved to `pages/queries/<filename>.md`. Want me to promote this into `pages/concept/<slug>.md`?"

Then stop. Do NOT pre-emptively promote.

## Step 8 — Handle promotion (only on user agreement)

If the user agrees in the next turn (any affirmative reply — yes / sure / do it / promote — counts as agreement; anything else counts as decline):

1. Compute the target path: `<root>/docs/wiki/pages/concept/<slug>.md` (drop the `<YYYY-MM-DD>-` prefix from the query file's name). Check whether the target already exists.
   - If it exists, refuse promotion and tell the user: `A concept page already exists at \`pages/concept/<slug>.md\`. Compile or earlier promotion created it. Merge by hand or pick a different slug — I won't overwrite it.` Then stop.
   - Otherwise continue.
2. Move the file in one step: `mv <root>/docs/wiki/pages/queries/<YYYY-MM-DD>-<slug>.md <root>/docs/wiki/pages/concept/<slug>.md`. Works on POSIX and on Windows via Git Bash.
3. Edit the moved file's frontmatter:
   - `type: query` → `type: concept`
   - `status: filed` → `status: active`
   - Drop `question:` and `informed-by:` fields.
   - Add `updated:` = today.
   - Add `sources:` derived as the deduplicated union of the `sources:` arrays of every page that was in `informed-by:`. Rationale: `sources:` must point at the underlying documents (raw/ files or in-repo docs) the page synthesizes from — NOT at other wiki pages. Cited wiki pages already appear as inline links in the body; re-listing them in `sources:` breaks the schema contract and the `/p-wiki:lint` dead-sources check.
4. Optionally run a follow-up backlink audit for the new concept page (same algorithm as compile step 4f).

## Edge cases

- Empty grep results → no page written, conversational reply only.
- Question is multi-part — split mentally, answer each, cite per part. Don't write multiple query pages.
- User asks the same question twice — the second query gets its own dated file. That's OK; lint will surface near-duplicates if it becomes a problem.
