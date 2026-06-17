---
name: compile
description: |
  Synthesize wiki pages from a source file. Accepts a path to any file in the repo (raw/ item, design spec, README, ADR, code doc). Without arguments, processes all `raw/**` items with `compiled: false`. Re-running on the same path is idempotent — derived pages get updated, not duplicated. Use when the user says "compile", "synthesize pages", "process the source", or names a doc to extract knowledge from.
argument-hint: "[<path>]"
allowed-tools: Bash(git rev-parse:*) Bash(node:*) Read Write Edit Grep Glob
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

For each entity, the target path is `<root>/docs/wiki/pages/<type>/<slug>.md`.

**If the page does NOT exist** (your normalised-title search in 4c found no match):

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" new <type> \
  --title "<title>" --tags "<csv>" \
  --source "<source-path>" --format=json
```

This handles the frontmatter (id, type, created, updated, status, sources) and slug-conflict resolution. On exit 2, follow the conflict prompts (overwrite vs. date-suffix). After CLI success, **Edit the body** of the newly created file to add the synthesized facts in the appropriate sections (Key facts / Main ideas / Related concepts) using the templates in `docs/wiki/CLAUDE.md`.

**If the page exists** (4c match):

1. Mutate frontmatter via CLI:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" set <existing-path> \
     --bump-updated --add-source "<source-path>" --format=json
   ```
2. Edit the body to add new facts in the appropriate sections. Do not remove existing content.

**Conflict callouts.** When a source contradicts a fact already on a page (e.g. a new ADR supersedes an older synthesis), do NOT silently overwrite — the conflict target is usually a *different* page than the one being compiled. For each affected target page:

1. Insert a callout at the top of the body, using the standardized leading marker so the prose stays human-readable but the date is parseable:
   ```
   > ⚠️ Conflict (since <YYYY-MM-DD>): <one line — what is superseded and by what, with links>. Body below reflects the pre-conflict sources.
   ```
2. Record the flag in frontmatter so `lint` can surface it later — **without** moving `updated`:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" set <target-path> --conflict-since <YYYY-MM-DD> --format=json
   ```
   Do NOT pass `--bump-updated` and do NOT hand-edit the `updated` field on a conflict-flag-only touch: the body was not reconciled, so `updated` must keep reflecting the last *reconciled* edit (this is what keeps the `stale` and `source-changed` lint checks meaningful).

**Reconciling a conflict.** When a later compile pass actually rewrites the body to agree with the new source, remove the callout and clear the flag in one CLI call (this DOES bump `updated`, since reconciliation is a real edit):
```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" set <target-path> --clear-conflict --add-source "<source-path>" --format=json
```

Callouts that compile leaves behind are closed in bulk by **`/p-wiki:reconcile`**, which sweeps flagged/stale pages, merges supersession cases with their current sources, removes the callouts, and leaves genuine conflicts for a human.

Apply [Markdown sanitization](#markdown-sanitization) to all body content before writing.

### 4e. Source-summary (raw sources only)

For raw sources, additionally create `<root>/docs/wiki/pages/source/<source-slug>-summary.md` using the source-summary template. `sources:` is `[<path to the raw file>]`.

Skip this step for in-repo sources — the original is already discoverable in the repo.

### 4f. Backlink audit

After steps 4a-4e have run across all sources in this compile pass, collect the full list of pages created or updated. Then for each such page, invoke:

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" backlinks <page-path> --format=json
```

The audit is done **once at the end of step 4 for the full touched-set**, not per-source.

Handle the exit code:

- **exit 0:** parse JSON; accumulate `inserted.length` into the run total for step 6's report.
- **exit 2:** read `candidates` from JSON. Show the user the first 10 candidates with their `preview` snippets, then ask: insert all (`--force`), skip this target, or raise the threshold to a chosen N.
  - "insert all" → re-run with `--force`.
  - "skip" → continue with the next target; record this target in the "deferred" list for the final report.
  - "raise to N" → re-run with `--max-suggestions=N`.
- **exit 1:** report the failed target in the final summary; continue with the next target (per-page failure does not abort compile).
- **exit 3:** forward stderr; abort compile and ask the user to file an issue.

### 4g. Stamp the raw frontmatter

If the source was a raw file (not in-repo), run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" set <raw-path> \
  --mark-compiled --add-compiled-to <new-page-path1> --add-compiled-to <new-page-path2> --format=json
```

For in-repo sources, do nothing — the original file is never modified.

## Step 5 — Regenerate `index.md`

After all backlink audits in step 4f complete, invoke:

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" index --format=json
```

Handle the exit code:

- **exit 0:** parse JSON; include "`<concept>` concept / `<person>` people / `<source>` sources / `<query>` queries pages indexed" in the final report (substituting actual counts from `groups`).
- **exit 1:** forward stderr to the user with a note: "compile completed but `index.md` was not regenerated; run `pwiki index` manually after resolving the error." Do not abort compile (page work is already done).
- **exit 3:** forward stderr; flag as a CLI bug.

## Step 6 — Report

Tell the user:
- N pages created, M updated.
- K backlinks added.
- Any conflict callouts inserted, listed by file.
- Any backlink-audit warnings deferred for human review.

## Markdown sanitization

Applies to every place this skill writes markdown — page bodies and source summaries. (Note: `index.md` summary lines are sanitized inside the CLI by `pwiki index`; the skill does not write `index.md` directly.)

Before writing markdown, wrap bare `<word>`-style tokens (e.g. `<group>`, `<vendor>`, `<tenant>`) in backticks: `` `<group>` ``. A token is "bare" if it is **not** already inside an inline-code span (`` `…` ``) or a fenced code block (` ``` … ``` `). Match pattern: `<` immediately followed by an ASCII letter, then word chars / hyphens, then `>`.

Why: Obsidian and CommonMark parse bare `<word>` as an opening HTML tag and stop rendering subsequent markdown until a matching close tag. In a dense list like `index.md`, one unescaped placeholder cascades to every following entry; in a page body it can swallow paragraphs after the offending line.

## Edge cases

- Source file exists but is empty → skip it and report.
- Source file references entities that share normalised titles with existing pages of a different type → prefer the existing type; do not duplicate across types.
- A page would exceed 2000 words after Edit → flag in the report, suggest splitting (don't auto-split).

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
| exit 2 with `existing-path` / `date-suffix-slug` (no `error.code`) | A page with that slug exists. Offer to reuse `existing-path` or write to the suggested `date-suffix-slug`. |
| `internal` | "Internal CLI error — file an issue against p-wiki." |
