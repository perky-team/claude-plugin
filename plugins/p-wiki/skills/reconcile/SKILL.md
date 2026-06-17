---
name: reconcile
description: |
  Resolve conflict callouts and stale pages in the wiki: re-merge a derived page with its current sources and remove the superseded callout, so conflicts don't accumulate forever. Genuine unresolved conflicts are left flagged for a human. Use when the user says "reconcile", "свести", "resolve conflicts", "remove superseded callouts", "merge the docs", or after `/p-wiki:lint` reports conflicts or changed sources.
argument-hint: "[<path>]"
allowed-tools: Bash(git rev-parse:*) Bash(node:*) Read Write Edit Grep Glob
---

# /p-wiki:reconcile

You are closing accumulated conflicts in the wiki: re-merging derived pages with their current sources and removing the superseded callouts. This is the **resolution** counterpart to `compile` (which only *flags* conflicts) and `lint` (which only *reports* them).

`$ARGUMENTS` is either empty (sweep the whole wiki) or a single path (reconcile one page).

## Step 1 — Find the wiki

`<root>` = `git rev-parse --show-toplevel`. Confirm `<root>/docs/wiki/CLAUDE.md` exists (it auto-loads). If not, stop and ask the user to run `/p-wiki:init` first.

## Step 2 — Collect targets

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" lint --format=json
```

From the JSON, take two warning buckets:

- **Conflicts** (`warnings.conflicts`) — pages carrying an unresolved conflict callout: a `conflict-since` flag and/or any blockquote callout mentioning `conflict`/`superseded` in the body (`> ⚠️ …`, `> **Superseded …**`, `> **Note:** … superseded …`), including legacy callouts with no flag. **These are the plashki to remove.** ADR / decision pages (filename/id/title starting `adr-<digit>`) are excluded by lint — their "superseded by …" notice is a permanent immutable record, not debt; do not reconcile them.
- **Stale** (`warnings['source-changed']`) — pages whose `sources:` were committed after the page's `updated`; the page may no longer reflect its source. This set is often large.

If `$ARGUMENTS` names a path, restrict both sets to that path. If both sets are empty (for the chosen scope), stop with "Nothing to reconcile."

## Step 3 — Confirm scope

Reconciling rewrites page bodies — an outward content change. Before writing anything, show the user:

- the count of **conflicts** (and list the files), and
- the count of **stale** pages.

Then ask which to process. **Default: conflicts only** (the stated goal — remove the plashki). Offer:
- conflicts only (default),
- conflicts + stale,
- a specific path or glob.

Do not process the stale set without explicit opt-in — re-compiling many pages is a large operation.

## Step 4 — Reconcile each target

For each page in the chosen scope:

### 4a. Read

Load the page (frontmatter + body, including any callout) with:

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" get <path> --format=json
```

Parse the JSON: `frontmatter` and `body` are returned separately. Detect the conflict callout in `body`. This works for both FS and Confluence wikis — do **not** use the `Read` tool for the wiki page (the source files in 4b are still read with `Read`).

### 4b. Gather authoritative sources

Collect the sources that define the *current* truth for this page:
- For a **conflict callout**: the sources the callout links to (e.g. the superseding ADRs) **plus** the page's existing `sources:`.
- For a **stale** page: the changed source file(s) **plus** existing `sources:`.

Read each of these source files.

### 4c. Classify — supersession vs genuine conflict

- **Supersession / stale-update** — a newer source clearly replaces the old model: an accepted decision whose text says it "supersedes"/"replaces" the prior one, or a source revised after the page, covering the same topic; the page's claims are an older version of what the source now says. → **Reconcile** (4d).
- **Genuine unresolved conflict** — two *currently-valid* sources state incompatible facts with no supersession relation between them. → **Leave** (4e).
- **When unsure, leave** (4e). Do not guess a winner.

### 4d. Reconcile (supersession)

Body editing here applies to a **filesystem** wiki. The `Edit` tool requires the page file to have been opened with `Read` first, so `Read` the page file now before rewriting it (Step 4a's `pwiki get` loaded the content for analysis but does not satisfy the `Edit` precondition). Rewriting a **Confluence** primary's body is not supported — see the storage-backend notes; leave such pages flagged.

1. Rewrite the affected body sections so they match the current sources. Remove now-wrong content; add the corrected facts in the appropriate sections (Key facts / pipeline / etc.). Apply [Markdown sanitization](#markdown-sanitization). **No invention** — every claim must trace to a source.
2. Remove the conflict callout block entirely.
3. Clear the flag, record the new source(s), and bump `updated` in one call:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" set <path> \
     --clear-conflict --add-source "<new-source-path>" --format=json
   ```
   (`--clear-conflict` is a safe no-op on the flag for a stale page that never had one, and still bumps `updated`.)

### 4e. Leave (genuine conflict)

1. Do **not** rewrite the body; keep the callout.
2. If the page has a callout but no `conflict-since` flag (a legacy callout), record one so `lint` tracks its age — without bumping `updated`:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" set <path> \
     --conflict-since <date-from-marker-or-today> --format=json
   ```
3. Add the page to the human-review list for the final report, with a one-line reason.

### 4f. Backlink audit

After steps 4a–4e have run across all reconciled pages, for each page you **edited the body of**, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" backlinks <path> --format=json
```

Handle exit codes exactly as `/p-wiki:compile` step 4f does: exit 0 accumulate `inserted`; exit 2 show candidates and ask insert-all / skip / raise threshold; exit 1 (plain stderr `pwiki: <msg>`) report and continue. (Exit 3 cannot occur for backlinks; only `index` reaches it.)

## Step 5 — Regenerate `index.md`

After all backlink audits complete:

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" index --format=json
```

Handle exit codes as `/p-wiki:compile` step 5 does.

## Step 6 — Report

Tell the user:
- **Reconciled:** N pages (list them) — callout removed, body merged, sources updated.
- **Left for human:** M pages (list them, each with the reason it's a genuine conflict, not a supersession).
- **No-ops:** K pages that needed no change.
- Backlinks added; index regenerated (yes/no).

Remind the user to review with `git diff` before committing.

## Markdown sanitization

Before writing markdown, wrap bare `<word>`-style tokens (e.g. `<group>`, `<tenant>`) in backticks: `` `<group>` ``. A token is "bare" if it is **not** already inside an inline-code span or a fenced code block. Match: `<` immediately followed by an ASCII letter, then word chars / hyphens, then `>`. (Obsidian/CommonMark otherwise parse a bare `<word>` as an HTML tag and stop rendering subsequent markdown.)

## Edge cases

- Empty target set for the chosen scope → "Nothing to reconcile."
- Single-path mode on a clean page (no callout, not stale) → report it as a no-op.
- A page would exceed 2000 words after the merge → flag in the report and suggest splitting; do not auto-split.
- The callout links to a source that no longer exists → leave the page, report it (a dead source is a lint concern, not a reconcile one).

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
