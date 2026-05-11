# Project knowledge wiki

This repository has an indexed knowledge wiki at `docs/wiki/`.
- Synthesized pages: `docs/wiki/pages/` (subdirs: concept/, person/, source/, queries/)
- Captured external sources: `docs/wiki/raw/` (articles/, files/, pastes/)
- Entry point for humans: `docs/wiki/index.md`

If the user asks a question that might be covered by accumulated project knowledge, prefer the wiki first: grep/read `docs/wiki/pages/` directly, or invoke `/x-wiki:query "<question>"` for a synthesized answer with citations.

## Adding repository docs to the wiki

When you (or another skill) finalize a document anywhere in this repo that captures durable knowledge worth searching later — a design spec, plan, ADR, README, architecture note, postmortem, or similar — run:

    /x-wiki:compile <path-to-doc>

This reads the file in place (no copy into `raw/`) and synthesizes concept pages with `sources: [<path-to-doc>]`. Re-running on the same path updates the derived pages instead of duplicating them.

Use `/x-wiki:ingest` only for external sources — URLs, pastes, or files from outside the repo. In-repo files should go through `/x-wiki:compile` directly.

Caveat: derived pages can become stale if the source doc later diverges from the implementation. `/x-wiki:lint` flags `status: active` pages older than 90 days; re-run `/x-wiki:compile <path>` after major edits to the source.

## Maintenance commands (plugin `x-wiki`)

- `/x-wiki:ingest <url|path|->` — capture an external source (URL, paste, or file from outside the repo) into raw/
- `/x-wiki:compile [path]` — synthesize pages from any source file in the repo, or from unprocessed raw/ items if no argument is given
- `/x-wiki:query "<question>"` — search the wiki and answer with citations
- `/x-wiki:lint` — audit links, orphan pages, stale frontmatter

Detailed frontmatter schemas, naming conventions, and link rules are in `docs/wiki/CLAUDE.md`, which auto-loads when Claude works with files under `docs/wiki/`.
