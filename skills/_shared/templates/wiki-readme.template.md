# Knowledge wiki

This is an indexed markdown knowledge base maintained by the `x-wiki` Claude Code plugin.

## Layout

- `pages/` — synthesized pages
  - `concept/` — ideas, technologies, patterns
  - `person/` — people
  - `source/` — summaries of external sources
  - `queries/` — answers to `/x-wiki:query` calls
- `raw/` — captured external sources (the originals, untouched)
  - `articles/` — downloaded URLs
  - `files/` — copies of files from outside the repo
  - `pastes/` — inline pastes from chat
- `index.md` — flat list of all pages by type
- `CLAUDE.md` — schemas and rules (auto-loaded when Claude works in this folder)

## How to use

- Add a source: `/x-wiki:ingest <url>` or, for files already in the repo, `/x-wiki:compile <path-to-doc>`.
- Build pages from sources: `/x-wiki:compile [path]`.
- Ask a question: `/x-wiki:query "<question>"`.
- Audit: `/x-wiki:lint`.

See the plugin's design spec for full conventions: it should be in `docs/superpowers/specs/` of the plugin repo.
