# Knowledge wiki

This is an indexed markdown knowledge base maintained by the `p-wiki` Claude Code plugin.

## Layout

- `pages/` — synthesized pages
  - `concept/` — ideas, technologies, patterns
  - `person/` — people
  - `source/` — summaries of external sources
  - `queries/` — answers to `/p-wiki:query` calls
- `raw/` — captured external sources (the originals, untouched)
  - `articles/` — downloaded URLs
  - `files/` — copies of files from outside the repo
  - `pastes/` — inline pastes from chat
- `index.md` — flat list of all pages by type
- `CLAUDE.md` — schemas and rules (auto-loaded when Claude works in this folder)

## How to use

- Add a source: `/p-wiki:ingest <url>` or, for files already in the repo, `/p-wiki:compile <path-to-doc>`.
- Build pages from sources: `/p-wiki:compile [path]`.
- Ask a question: `/p-wiki:query "<question>"`.
- Audit: `/p-wiki:lint`.

For full conventions (frontmatter schemas, naming, link rules, compile rules), see `CLAUDE.md` in this folder. It auto-loads when Claude works with files in `docs/wiki/`.
