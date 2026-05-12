---
name: lint
description: |
  Audit the wiki for problems: dead links, orphan pages, frontmatter errors, underlinked concept pages, stale entries. Reports only — never fixes automatically. Use when the user says "lint wiki", "check the wiki", "audit wiki", or asks whether the wiki has issues.
argument-hint: (no arguments)
allowed-tools: Bash(git rev-parse:*) Read Grep Glob
---

# /x-wiki:lint

You are auditing the wiki and producing a report. You do NOT modify any wiki files.

## Step 1 — Find the wiki

`<root>` = `git rev-parse --show-toplevel`. Confirm `<root>/docs/wiki/CLAUDE.md` exists.

## Step 2 — Build inventory

Glob `<root>/docs/wiki/pages/**/*.md`. For each file, Read it and capture:
- Path
- Frontmatter (parsed)
- Body
- Outgoing markdown links `[text](path)` (in body)
- `sources:` paths (from frontmatter)

## Step 3 — Run checks

Group findings by **error** (must fix) and **warning** (should look at).

### Dead links (error)

For each outgoing body link `(<path>)`:
- Resolve relative to the file's directory.
- Confirm the target exists on disk.
- If not, record `{file, link-text, target-path}`.

### Dead sources (error)

For each `sources:` entry:
- Resolve relative to `<root>`.
- Confirm the target exists.
- If not, record `{file, source-path}`.

### Orphan pages (warning)

For each page that isn't `index.md` and isn't in `pages/queries/`:
- Grep all other pages for any link whose target resolves to this page.
- If none, record `{file}` as an orphan.

### Frontmatter (error)

For each page:
- Required fields per type must be present: base fields always; type-specific fields per the schema in `docs/wiki/CLAUDE.md`.
- `type:` must match the parent directory: `pages/concept/foo.md` must have `type: concept`. Mismatch → record `{file, expected, actual}`.

### Underlinked (warning)

For each concept page with `status:` ≠ `draft`:
- Count outgoing links to other pages (anywhere in `pages/`).
- If < 3, record `{file, count}`.

### Stale (warning)

For each page with `status: active`:
- If `updated:` is older than 90 days from today, record `{file, updated-date, days-since}`.

## Step 4 — Report

Print a report in chat. Group by check, errors first. Format like:

```
Dead links (errors): 2
  - pages/concept/foo.md → ../source/missing.md
  - pages/queries/2026-04-01-bar.md → pages/concept/gone.md

Frontmatter (errors): 1
  - pages/person/baz.md — type mismatch: expected `person`, actual `concept`

Orphan pages (warnings): 3
  - pages/concept/lonely.md
  ...

Underlinked (warnings): 1
  - pages/concept/sparse.md — 1 outgoing link

Stale (warnings): 0

Total: 3 errors, 4 warnings.
```

End with: "Run `/x-wiki:compile` after fixes, then re-lint."

Do not propose fixes inline — let the user decide.

## Edge cases

- A page with broken frontmatter (YAML parse error) → record as a frontmatter error and skip the other checks for that file.
- Symlinks → resolve and treat as their target.
- A page that mentions a stale `sources:` path that's been moved → still an error; suggest the user search for the new path.
