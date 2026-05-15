---
name: ingest
description: |
  Capture an external source into the wiki's raw/ folder. Accepts a URL, a path to a file OUTSIDE the repo, or `-` for the last paste from chat. For files already in the repo, refuse and point the user to `/p-wiki:compile <path>` (no copy needed). Use when the user says "ingest", "save to wiki", "add to wiki", or supplies a URL/file they want captured.
argument-hint: <url|path|->
allowed-tools: Bash(git rev-parse:*) Bash(realpath:*) Bash(node:*) Read Write Grep WebFetch
---

# /p-wiki:ingest

You are capturing one external source into the `p-wiki` raw/ folder.

`$ARGUMENTS` is one of:
- A URL beginning with `http://` or `https://`.
- An absolute or relative path to a file.
- The literal `-` (meaning "use the last large paste from the conversation").

## Step 1 — Find the wiki

Run `git rev-parse --show-toplevel` to get `<root>`. Confirm `<root>/docs/wiki/CLAUDE.md` exists. If not, stop and tell the user to run `/p-wiki:init` first.

## Step 2 — Classify the argument and reject in-repo paths

- If `$ARGUMENTS` matches `^https?://` → it's a URL. Continue to Step 3 (URL branch).
- Else if `$ARGUMENTS` == `-` → it's a paste. Continue to Step 3 (paste branch).
- Else treat as a path. Resolve to an absolute path via `realpath` (e.g. `realpath -- "<arg>"` via Bash). If `realpath` fails (path doesn't exist), report "file not found: <arg>" and stop.
  - If the resolved path is under `<root>/` → REFUSE. Tell the user: "That file is already in the repo. Use `/p-wiki:compile <path>` directly — no point copying." Stop here.
  - Else continue to Step 3 (external file branch).

## Step 3 — Capture

Each branch ends by calling `pwiki new raw-<kind>`. The CLI owns slug, frontmatter, and conflict handling; the skill provides the body content via stdin or file.

### URL branch

1. WebFetch the URL with: "Convert this page to clean markdown, preserving headings, lists, code blocks. Return only the markdown content; no commentary."
2. Note the page title (from the `<title>` tag or first H1) — you'll pass it via `--title`.
3. Pipe the fetched markdown into:
   ```bash
   echo "<fetched-markdown>" | node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" new raw-article \
     --title "<title>" --source-url "<url>" --source-type article \
     --ingested-from=- --format=json
   ```
4. **On exit 2** (slug conflict), JSON body contains `existing-path`. Check whether `existing-path` was the same URL (Read the file's `source-url:`):
   - Same URL → ask user: "this URL was already captured as `<existing-filename>` — replace it, or save the new copy under a dated slug?"
   - Different URL → ask user: "filename `<slug>.md` is taken by an unrelated source — overwrite it, or use the dated slug `<date-suffix-slug>`?"
   Retry with `--on-conflict=overwrite` or `--on-conflict=date-suffix`.

### External file branch

1. Read the file. For PDFs, Claude Code's Read tool extracts text. For binaries other than PDF, refuse with: "Can only ingest text-readable files."
2. Call:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" new raw-file \
     --title "<basename-as-human>" --source-type <picked-type> \
     --ingested-from "<absolute-path>" --format=json
   ```
3. Handle exit 2 as above.

### Paste branch

1. Find the largest user-supplied paste in the conversation. If none clear, ask the user to re-paste.
2. Pick a 3–6 word title via LLM reasoning.
3. Build the slug explicitly as `<YYYY-MM-DD>-<kebab-title>` (`pwiki new` only date-prefixes slugs for `type=query`; for `raw-paste` you must pass the dated slug via `--slug`):
   ```bash
   echo "<paste-body>" | node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" new raw-paste \
     --title "<picked-title>" --slug "<YYYY-MM-DD>-<kebab-title>" \
     --ingested-from=- --format=json
   ```
   The CLI sets `source-type: doc` automatically for `raw-paste`.
4. Handle exit 2 as above.

After each branch, the CLI's JSON output contains `path` and `slug`. Use them in Step 4.

## Step 4 — Report

Tell the user:
- What was saved and where (full path).
- The slug and approximate word count.
- The suggested next step: `/p-wiki:compile <that-path>`.

Do not run compile automatically.

## Edge cases

- URL that returns non-text (image, binary) → refuse with the WebFetch error.
- File path that does not exist → refuse with "file not found: …".
- Paste branch when the conversation has no large paste → ask the user to paste the content as the next message and re-run.
