# p-wiki release notes

This file starts at 4.14.0. Earlier versions are not reconstructed here — read
`git log -- plugins/p-wiki/` for those.

## v4.14.0

**Connect another wiki as a read-only source with one command.**

Sources were the one part of a wiki you had to hand-write. `/p-wiki:init` asked where to
write and whether to mirror, but nothing offered to *read* another wiki, so `sources` and
`destinations` had to be typed into `.pwiki.json` by hand — and a typo in a path or a repo
name only surfaced later, as empty search results in an unrelated session.

- **New CLI command `pwiki source add <name>`.** Refuses a name already used by the
  primary, a mirror, or another source; builds the block from `--kind`
  (`fs` / `github` / `gitlab` / `http`) or copies one out of another wiki's config with
  `--from-config` (plus `--from-destination` to pick a block that is not that wiki's
  primary); validates the whole config; then probes the source and **writes nothing** if
  the probe fails. `--no-verify` skips the probe when the source is legitimately
  unreachable right now, such as a token that lives on another machine.
- **`--from-config` is the practical route to a Confluence source** — that block carries
  space and page ids nobody should retype.
- **`/p-wiki:init` Step 8** drives that command through a dialog, and **Step 4 no longer
  dead-ends on an existing wiki**: it skips the scaffold and goes straight to the sources
  offer. Re-running `/p-wiki:init` is how sources get added later, not only at creation.
- **Stricter fs probe:** an `fs` source must contain `docs/wiki/CLAUDE.md`, the same
  marker the CLI uses to find a wiki root. A stale checkout or a half-deleted wiki with an
  empty `docs/wiki/` used to pass and then return nothing on every search.
- The generated wiki `CLAUDE.md` documents the command and rules out hand-editing the
  config.

Docs: `README.md` § Adding a source with one command, `CONTRIBUTING.md` § Never use the
global `fetch` in the CLI.
