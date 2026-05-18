---
name: query
description: |
  Answer a question using the wiki's pages, with citations. Writes the answer to `pages/queries/<date>-<slug>.md` and conversationally offers to promote it to a concept page. Use when the user says "query wiki", "ask the wiki", "what does the wiki say about X", or asks a question that might be covered by accumulated project knowledge.
argument-hint: "<question>"
allowed-tools: Bash(git rev-parse:*) Bash(node:*) Read Edit
---

# /p-wiki:query

You are answering one question using the wiki's pages and saving the answer.

`$ARGUMENTS` is the verbatim question.

## Step 1 — Find the wiki

`<root>` = `git rev-parse --show-toplevel`. Confirm `<root>/docs/wiki/CLAUDE.md` exists. If not, stop with "run `/p-wiki:init` first".

## Step 2 — Search

Call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" search "$ARGUMENTS" \
  --in=pages --limit=10 --format=json
```

Parse the JSON. If `total === 0`, stop and tell the user: "Nothing in the wiki covers that. Try ingesting a source first." Do not write a query page.

## Step 3 — Read top results

For each `path` in `results`, use Read to load the full page body. Cite only files you actually read.

## Step 5 — Synthesize the answer

Compose a 1–3 paragraph answer. Cite specific pages inline using markdown links: `[Title](pages/concept/foo.md)`. Never claim something the cited pages don't support; if the wiki is silent or contradictory on a point, say so.

## Step 6 — Write the query-output page

Use `pwiki new query`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" new query \
  --title "<3-6-word condensation of question>" \
  --question "<verbatim original question>" \
  --tags "<topics>" \
  --informed-by <path1> --informed-by <path2> ... \
  --format=json
```

The CLI sets `id`, `created`, `status: filed`, and writes the file under `pages/queries/YYYY-MM-DD-<slug>.md` (date prefix for query slugs). It returns the new path in JSON.

Then **Edit the body** of the new file to insert the synthesized answer from Step 5 (the CLI writes a stub body only — see the query template in `docs/wiki/CLAUDE.md`).

## Step 7 — Reply and invite promotion

Return the answer to the user in chat. End your reply with one short line like:

> "Saved to `pages/queries/<filename>.md`. Want me to promote this into `pages/concept/<slug>.md`?"

Then stop. Do NOT pre-emptively promote.

## Step 8 — Handle promotion (only on user agreement)

If the user agrees in the next turn (any affirmative reply — yes / sure / do it / promote — counts as agreement; anything else counts as decline):

1. Use the repo-root-relative `path` returned by `pwiki new query` in Step 6 (e.g. `docs/wiki/pages/queries/<YYYY-MM-DD>-<slug>.md`) as `<query-path>`. The CLI derives the target concept slug by stripping the `YYYY-MM-DD-` prefix from the page's `id`. Run:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" promote <query-path> --to=concept --format=json
   ```
2. Exit codes:
   - 0 → JSON has `to:` and `sources:`. The CLI has moved the file and rewritten the frontmatter. **Edit the moved file's body** if you want to reshape it from query-answer format to concept-page format (Key facts / Related concepts) — optional, content concern.
   - 2 → JSON has `existing-path`. Tell the user: ``A concept page already exists at `<existing-path>`. I won't overwrite it.`` Stop.
3. (Optional) backlink audit for the new concept (same algorithm as compile step 4f — still a skill concern in v1).

## Edge cases

- Empty grep results → no page written, conversational reply only.
- Question is multi-part — split mentally, answer each, cite per part. Don't write multiple query pages.
- User asks the same question twice — the second query gets its own dated file. That's OK; lint will surface near-duplicates if it becomes a problem.

## Error handling

If `pwiki <command>` exits non-zero, parse the JSON `error.code` field:

| error.code | What to say to the user |
|---|---|
| `auth-failed` | "Check PWIKI_CONFLUENCE_EMAIL / PWIKI_CONFLUENCE_TOKEN; verify the token grants access to the space." |
| `config-invalid` | "Confluence config invalid — re-run `/p-wiki:init`." |
| `page-not-found` | "Page `<path>` no longer exists in Confluence." |
| `rate-limited` | "Confluence rate-limited; retry in a few minutes." |
| `network-error` | "Confluence is unavailable; retry later." |
| `version-conflict` | "Page was modified concurrently; re-run the command." |
| `slug-taken` | Existing slug-conflict prompt (overwrite / date-suffix) — unchanged. |
| `target-exists` | Existing callout — unchanged. |
| `schema-violation` | Existing behavior — unchanged. |
| `internal` | "Internal CLI error — file an issue against p-wiki." |
