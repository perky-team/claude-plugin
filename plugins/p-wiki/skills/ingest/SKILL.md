---
name: ingest
description: |
  Capture an external source into the wiki's raw/ folder. Accepts a URL, a path to a file OUTSIDE the repo, or `-` for the last paste from chat. For files already in the repo, refuse and point the user to `/p-wiki:compile <path>` (no copy needed). Use when the user says "ingest", "save to wiki", "add to wiki", or supplies a URL/file they want captured.
argument-hint: <url|path|->
allowed-tools: Bash(git rev-parse:*) Bash(realpath:*) Read Write Grep WebFetch
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

### URL branch

1. WebFetch the URL with a prompt like: "Convert this page to clean markdown, preserving headings, lists, code blocks. Return only the markdown content; no commentary."
2. Pick a slug:
   - Prefer a slug derived from the page's `<title>` if extractable.
   - Else from the URL path's last segment.
   - kebab-case, ASCII, 1–50 chars.
3. Check for conflicts in this order:
   a. **Same URL already captured (potentially under a different slug):** Grep `<root>/docs/wiki/raw/articles/` for `^source-url: <url>$` (using the Grep tool). If a match is found, identify the existing file by name and ask: "this URL was already captured as `<existing-filename>` — replace it, or save the new copy under a dated slug?"
   b. **Same slug exists with a different URL:** if `<root>/docs/wiki/raw/articles/<slug>.md` exists and its `source-url` is something else, ask: "filename `<slug>.md` is taken by an unrelated source — overwrite it, or use the dated slug `<slug>-YYYY-MM-DD.md`?"
   If the user declines overwrite in either case, append `-YYYY-MM-DD` to the slug.
4. Build the frontmatter per the raw-file schema in `docs/wiki/CLAUDE.md` (auto-loaded). Set: `id: <slug>`, `type: raw-article`, `title:` extracted from the page's `<title>` (or first H1 if no title tag), `source-url:` the URL, `source-type: article`, `ingested:` today's ISO date, `compiled: false`, `compiled-to: []`.
5. Write `<root>/docs/wiki/raw/articles/<slug>.md` with the frontmatter followed by the fetched markdown body.

### External file branch

1. Read the file. For PDFs, Claude Code's Read tool extracts text; rely on that. For binaries other than PDF, refuse with: "Can only ingest text-readable files. Convert it first."
2. Slug from the file's base name (without extension), kebab-case. Conflict → suffix with date.
3. Frontmatter per the raw-file schema in `docs/wiki/CLAUDE.md`: `id: <slug>`, `type: raw-file`, `title:` the file's base name (without extension) in human-readable form, `source-url: null`, `source-type:` pick one of `paper|transcript|code|doc` based on file extension/content, `ingested:` today, `compiled: false`, `compiled-to: []`.
4. Write `<root>/docs/wiki/raw/files/<slug>.md` with frontmatter + content.

### Paste branch

1. Scan the conversation backward for the largest user-supplied text block that isn't already part of a prior tool result. If you can't find a clear candidate, ask the user to re-paste the content.
2. Pick a 3–6 word title for the content via LLM reasoning. Slug = kebab-case of the title.
3. File name: `<YYYY-MM-DD>-<slug>.md`.
4. Frontmatter per the raw-file schema in `docs/wiki/CLAUDE.md`: `id: <YYYY-MM-DD>-<slug>` (same as filename without `.md`), `type: raw-paste`, `title:` the 3–6 word title chosen in step 2, `source-url: null`, `source-type: doc`, `ingested:` today, `compiled: false`, `compiled-to: []`.
5. Write `<root>/docs/wiki/raw/pastes/<filename>` with frontmatter + paste body.

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
