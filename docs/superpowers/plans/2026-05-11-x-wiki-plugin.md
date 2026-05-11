# x-wiki Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin called `x-wiki` that turns any git repo into an indexed markdown knowledge base under `docs/wiki/`, driven by five skills (`init`, `ingest`, `compile`, `query`, `lint`).

**Architecture:** Five `SKILL.md` files under `skills/<name>/SKILL.md` — each becomes a slash command (`/x-wiki:<name>`) plus an auto-activated skill. Shared content (the `docs/wiki/CLAUDE.md` body, the rule body, README/index stubs) lives in `skills/_shared/templates/` and is read at runtime by the `init` skill via `${CLAUDE_SKILL_DIR}/../_shared/templates/<file>`. No `commands/`, no `hooks/`, no `scripts/`, no external deps.

**Tech Stack:** Markdown + YAML frontmatter. Built-in Claude Code tools only (Read/Write/Edit/Grep/Glob/WebFetch/Bash). Plugin manifest in `.claude-plugin/plugin.json`.

**Source of truth for design decisions:** [docs/superpowers/specs/2026-05-11-x-wiki-plugin-design.md](../specs/2026-05-11-x-wiki-plugin-design.md). Read this once before starting.

**Working directory:** `C:\projects\tssd\x` — the plugin lives in this repo. The repo's existing files (only `docs/` so far) are untouched by the plan apart from new commits.

---

## File map

| Path | Purpose | Created in task |
|---|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest (name, version, description) | 1 |
| `README.md` | How to install the plugin, what it does, usage cheatsheet | 1 |
| `.gitignore` | Standard ignores (OS junk) | 1 |
| `skills/_shared/templates/wiki-claude-md.template.md` | Body of `docs/wiki/CLAUDE.md` written out by `init` | 2 |
| `skills/_shared/templates/wiki-readme.template.md` | Body of `docs/wiki/README.md` written out by `init` | 2 |
| `skills/_shared/templates/wiki-index.template.md` | Initial empty body of `docs/wiki/index.md` | 2 |
| `skills/_shared/templates/x-wiki-rule.template.md` | Body of `<repo>/.claude/rules/x-wiki.md` written out by `init` | 2 |
| `skills/init/SKILL.md` | Scaffold the wiki under `docs/wiki/` and the global rule | 3 |
| `skills/ingest/SKILL.md` | Capture external sources (URL / outside-repo file / paste) into `raw/` | 4 |
| `skills/compile/SKILL.md` | Synthesize pages from raw/ items or in-repo files | 5 |
| `skills/query/SKILL.md` | Search the wiki and produce a query-output page with citations | 6 |
| `skills/lint/SKILL.md` | Audit links, orphans, frontmatter, staleness | 7 |

---

## Pre-flight reading

Before starting:

1. Read the spec end-to-end: `docs/superpowers/specs/2026-05-11-x-wiki-plugin-design.md`.
2. Skim the live skills doc to confirm the frontmatter fields are still current. WebFetch `https://code.claude.com/docs/en/skills` and check:
   - `name`, `description`, `argument-hint`, `allowed-tools` are still the recommended fields.
   - `${CLAUDE_SKILL_DIR}` substitution is still supported.
   - `disable-model-invocation` / `user-invocable` semantics are unchanged.
3. Skim the live plugins doc: `https://code.claude.com/docs/en/plugins` (or its redirect target). Confirm the `.claude-plugin/plugin.json` shape and whether a `marketplace.json` is needed for local development install.

If anything in the spec contradicts current docs, prefer the live docs and note the divergence in a commit message.

---

## Task 1: Plugin scaffold (manifest + README + .gitignore)

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `README.md`
- Create: `.gitignore`

- [ ] **Step 1: Confirm plugin.json shape via live docs**

WebFetch `https://code.claude.com/docs/en/plugins`, look at the section that defines `plugin.json` fields. Confirm at minimum these fields are accepted: `name`, `version`, `description`. If the doc shows `author`, `homepage`, `repository` etc. as optional, you may include them; otherwise keep the manifest minimal.

- [ ] **Step 2: Create `.claude-plugin/plugin.json`**

Write this content (adjust if Step 1 surfaced new required fields):

```json
{
  "name": "x-wiki",
  "version": "0.1.0",
  "description": "Persistent markdown knowledge wiki under docs/wiki/. Skills: init, ingest, compile, query, lint."
}
```

- [ ] **Step 3: Create `README.md`**

```markdown
# x-wiki

A Claude Code plugin that turns any git repo into an indexed markdown knowledge wiki under `docs/wiki/`. Skills: `init`, `ingest`, `compile`, `query`, `lint`.

## Install (local dev)

1. Clone this repo somewhere.
2. Add it to Claude Code as a plugin via `/plugin` (or whatever the current install command is — see `https://code.claude.com/docs/en/plugins`).
3. Open a project repo. Run `/x-wiki:init`.

## Commands

| Command | What it does |
|---|---|
| `/x-wiki:init` | Scaffolds `docs/wiki/` and a global rule at `.claude/rules/x-wiki.md`. |
| `/x-wiki:ingest <url\|path\|->` | Captures an external source (URL, outside-repo file, or inline paste) into `docs/wiki/raw/`. For files already in the repo, use `/x-wiki:compile <path>` directly. |
| `/x-wiki:compile [path]` | Synthesizes pages from a source file (raw/ or anywhere in the repo). Without an argument, processes all `raw/**` items with `compiled: false`. |
| `/x-wiki:query "<question>"` | Searches the wiki and writes a query-output page with citations. |
| `/x-wiki:lint` | Audits links, orphan pages, frontmatter, staleness. Reports only — does not auto-fix. |

## Design

See `docs/superpowers/specs/2026-05-11-x-wiki-plugin-design.md` in this repo.
```

- [ ] **Step 4: Create `.gitignore`**

```gitignore
# OS junk
.DS_Store
Thumbs.db
desktop.ini

# Editor caches
.vscode/
.idea/
*.swp
*.swo
```

- [ ] **Step 5: Validate JSON parses**

Run: `python -c "import json; json.load(open('.claude-plugin/plugin.json'))"`
Expected: no output, exit code 0.

If Python is not available, use: `node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8'))"`.

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/plugin.json README.md .gitignore
git commit -m "feat: plugin scaffold (manifest, README, gitignore)"
```

---

## Task 2: Template files

Templates are the bodies of files that `/x-wiki:init` writes into the user's project. Putting them in standalone files (not inline in the init SKILL.md) keeps the init skill short and makes the templates editable on their own.

**Files:**
- Create: `skills/_shared/templates/wiki-claude-md.template.md`
- Create: `skills/_shared/templates/wiki-readme.template.md`
- Create: `skills/_shared/templates/wiki-index.template.md`
- Create: `skills/_shared/templates/x-wiki-rule.template.md`

- [ ] **Step 1: Create `wiki-claude-md.template.md`**

This is the long one — copy §4 of the spec verbatim (Frontmatter, Naming, Link rules, Compile rules, Page body templates). Write it as a self-contained markdown doc with `# Wiki rules and schemas` as the title.

Content (full, ~150 lines):

````markdown
# Wiki rules and schemas

This file is auto-loaded by Claude Code whenever it reads files under `docs/wiki/`. It defines the schemas, naming rules, link rules, and compile rules every skill in plugin `x-wiki` follows.

## Frontmatter

### Base fields (all 4 page types)

```yaml
id: <slug>                # = filename without .md
type: concept             # concept | person | source | query
title: <human-readable>
created: 2026-05-11       # ISO 8601
updated: 2026-05-11
status: active            # active | stale | draft
tags: [topic1, topic2]
sources: []               # paths the page depends on; ALWAYS relative to repo root. May live in docs/wiki/raw/ or anywhere else in the repo.
```

- `concept` — no extra fields.
- `person` — no extra fields.

### `source`

```yaml
source-url: https://...
source-type: article      # article | paper | transcript | code | doc
```

### `query`

```yaml
question: "<verbatim original>"
informed-by:
  - pages/concept/foo.md
status: filed             # filed | promoted
```

(base: only `id`, `type`, `title`, `created`, `status`, `tags`)

### Raw files (in `raw/`)

```yaml
id: <slug>
type: raw-article | raw-file | raw-paste
title: <extracted>
source-url: <url|null>
source-type: article | paper | transcript | code | doc
ingested: 2026-05-11
compiled: false
compiled-to: []
```

In-repo files used as sources are NOT modified by the plugin. They appear in `sources:` arrays of pages by their repo-root-relative path.

## Naming

- Slug = kebab-case, ASCII or transliterated, 1–50 chars.
- Conflict → suffix with date: `pods.md` taken → `pods-2026-05-11.md`.
- Query pages: always `<date>-<slug>.md`.
- The subdirectory = the type; mismatch between `type:` and the directory is a lint error.

## Link rules

- Plain markdown `[text](relative/path.md)`. No `[[wikilinks]]`.
- Paths relative to the file containing the link.
- A concept page must have ≥3 outgoing links to other pages (enforced by `/x-wiki:lint`; `status: draft` exempt).
- **Backlink audit during compile is mandatory.**
- Links to `raw/` are allowed only in the `sources:` frontmatter field, never in body text.

## Compile rules

- **No invention.** Every claim must trace back to a source listed in `sources:`. If a source does not support a claim, leave it out.
- Concept page length: 800–2000 words. Larger → split into sub-pages and link.
- Source-summary length: 300–600 words.
- Factual conflicts between sources — do not silently overwrite. Insert a callout block in both affected pages:
  ```
  > ⚠️ Conflict: [source A](../source/a-summary.md) claims X. [source B](../source/b-summary.md) claims Y.
  ```
- Update vs create: if a page with the same id exists → Edit (don't recreate, don't duplicate).
- Slug stability: before creating a new page, normalise the candidate title (lowercase, strip punctuation, collapse spaces) and check `pages/<type>/*` for an existing page whose normalised title matches. Match → Edit it; no match → Write new.
- Backlink audit safety: (a) case-sensitive whole-word match against the exact `title:` from frontmatter, (b) skip occurrences already inside a markdown link or inside a fenced/inline code block, (c) link only at the first qualifying occurrence per file.

## Page body templates (recommended, not strict)

### Concept / person

````markdown
---
<frontmatter>
---

# <Title>

Definition in 1–2 sentences.

## Key facts
- fact 1 (from [source-summary](../source/foo-summary.md))
- fact 2

## Related concepts
- [Related A](./related-a.md) — short context of the relation
- [Related B](../person/related-b.md)

## Sources
See `sources:` in frontmatter.
````

### Source-summary

````markdown
---
<frontmatter — base fields + source-url, source-type>
---

# Summary: <Original title>

**Original:** [<url>](<url>) · *<source-type>*

## Main ideas
- idea 1
- idea 2

## Extracted concepts
- [Concept A](../concept/a.md)
- [Person X](../person/x.md)
````

### Query output

````markdown
---
<frontmatter — id, type=query, title, created, status, tags, question, informed-by>
---

# <Title>

**Q:** <question verbatim>

**A:** <short answer, 1–3 paragraphs>

## Based on
- [Concept A](../concept/a.md) — what was used
- [Source B summary](../source/b-summary.md)
````
````

- [ ] **Step 2: Create `wiki-readme.template.md`**

```markdown
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
```

- [ ] **Step 3: Create `wiki-index.template.md`**

```markdown
# Wiki index

This file is regenerated by `/x-wiki:compile` and `/x-wiki:lint`. Don't edit by hand.

## Concepts
_(none yet)_

## People
_(none yet)_

## Sources
_(none yet)_

## Queries
_(none yet)_
```

- [ ] **Step 4: Create `x-wiki-rule.template.md`**

Copy the rule body from §5 of the spec verbatim. Content:

````markdown
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
````

- [ ] **Step 5: Verify all four files exist and are non-empty**

Run: `ls -la skills/_shared/templates/` and check that each `.template.md` file is present and non-empty.

- [ ] **Step 6: Commit**

```bash
git add skills/_shared/templates/
git commit -m "feat: wiki templates (CLAUDE.md body, readme, index, global rule)"
```

---

## Task 3: `/x-wiki:init` skill

**Files:**
- Create: `skills/init/SKILL.md`

The init skill scaffolds `docs/wiki/` and the global rule. Per §3.1 of the spec.

- [ ] **Step 1: Write `skills/init/SKILL.md`**

```markdown
---
name: init
description: |
  Initialize a markdown knowledge wiki at `docs/wiki/` of the current git repo and a global rule at `.claude/rules/x-wiki.md`. Use when the user says "init wiki", "create wiki", "setup knowledge base", or asks to start a new x-wiki.
argument-hint: (no arguments)
allowed-tools: Bash(git rev-parse:*) Bash(mkdir:*) Bash(ls:*) Read Write
---

# /x-wiki:init

You are scaffolding the `x-wiki` knowledge base inside the current repo.

## Step 1 — Find the repo root

Run `git rev-parse --show-toplevel` via Bash. If it fails (not a git repo), ask the user once whether to use the current working directory as the root. If they decline, stop. If they accept, use CWD.

Hereafter `<root>` = the resolved repo root.

## Step 2 — Refuse if already initialised

If `<root>/docs/wiki/` exists, stop and tell the user: "Wiki already initialised at `<root>/docs/wiki/`. Remove the directory by hand if you want to reset it."

## Step 3 — Create the layout

Create these directories (use `mkdir -p` via Bash):

```
<root>/docs/wiki/
<root>/docs/wiki/raw/articles/
<root>/docs/wiki/raw/files/
<root>/docs/wiki/raw/pastes/
<root>/docs/wiki/pages/concept/
<root>/docs/wiki/pages/person/
<root>/docs/wiki/pages/source/
<root>/docs/wiki/pages/queries/
```

Put a `.gitkeep` file in each leaf directory (8 files) so git tracks empty dirs.

## Step 4 — Write the wiki content files

Read the templates from this skill's bundle and write them into the wiki:

| Read from | Write to |
|---|---|
| `${CLAUDE_SKILL_DIR}/../_shared/templates/wiki-claude-md.template.md` | `<root>/docs/wiki/CLAUDE.md` |
| `${CLAUDE_SKILL_DIR}/../_shared/templates/wiki-readme.template.md` | `<root>/docs/wiki/README.md` |
| `${CLAUDE_SKILL_DIR}/../_shared/templates/wiki-index.template.md` | `<root>/docs/wiki/index.md` |

Copy verbatim — no transformations.

## Step 5 — Write the global rule

Ensure `<root>/.claude/rules/` exists (`mkdir -p`). Then:

- If `<root>/.claude/rules/x-wiki.md` already exists, do NOT overwrite. Tell the user the file is present and they should review it before proceeding.
- Otherwise, copy `${CLAUDE_SKILL_DIR}/../_shared/templates/x-wiki-rule.template.md` to `<root>/.claude/rules/x-wiki.md` verbatim.

## Step 6 — Final message

Tell the user, in order:

1. Where the wiki was created (`<root>/docs/wiki/`).
2. That the global rule was created (or already existed) at `<root>/.claude/rules/x-wiki.md`.
3. Suggest next steps:
   - For an external source: `/x-wiki:ingest <url-or-path>`.
   - For a doc already in the repo (spec, README, ADR, etc.): `/x-wiki:compile <path>`.
4. Remind them this is just a scaffold — they're free to commit it or not.

## Edge cases

- If `mkdir -p` fails (e.g. permission), stop and tell the user the exact error.
- If a template file can't be read (`${CLAUDE_SKILL_DIR}/../_shared/templates/X` missing), abort and tell the user the plugin install may be corrupted.
```

- [ ] **Step 2: Validate the frontmatter parses**

Open the file and verify by eye that:
- The `---` markers are on their own lines.
- `name`, `description`, `argument-hint`, `allowed-tools` are top-level YAML keys.
- The multiline `description` uses `|` block scalar (so newlines are preserved literally).

If a YAML parser is available locally, run it (e.g. `python -c "import yaml; print(yaml.safe_load(open('skills/init/SKILL.md').read().split('---')[1]))"`). Otherwise eyeball it.

- [ ] **Step 3: Commit**

```bash
git add skills/init/SKILL.md
git commit -m "feat: /x-wiki:init skill"
```

---

## Task 4: `/x-wiki:ingest` skill

**Files:**
- Create: `skills/ingest/SKILL.md`

Per §3.2 of the spec. Captures external sources only — files already in the repo are refused with a pointer to `/x-wiki:compile`.

- [ ] **Step 1: Write `skills/ingest/SKILL.md`**

```markdown
---
name: ingest
description: |
  Capture an external source into the wiki's raw/ folder. Accepts a URL, a path to a file OUTSIDE the repo, or `-` for the last paste from chat. For files already in the repo, refuse and point the user to `/x-wiki:compile <path>` (no copy needed). Use when the user says "ingest", "save to wiki", "add to wiki", or supplies a URL/file they want captured.
argument-hint: <url|path|->
allowed-tools: Bash(git rev-parse:*) Bash(test:*) Read Write Grep WebFetch
---

# /x-wiki:ingest

You are capturing one external source into the `x-wiki` raw/ folder.

`$ARGUMENTS` is one of:
- A URL beginning with `http://` or `https://`.
- An absolute or relative path to a file.
- The literal `-` (meaning "use the last large paste from the conversation").

## Step 1 — Find the wiki

Run `git rev-parse --show-toplevel` to get `<root>`. Confirm `<root>/docs/wiki/CLAUDE.md` exists. If not, stop and tell the user to run `/x-wiki:init` first.

## Step 2 — Classify the argument and reject in-repo paths

- If `$ARGUMENTS` matches `^https?://` → it's a URL. Continue to Step 3 (URL branch).
- Else if `$ARGUMENTS` == `-` → it's a paste. Continue to Step 3 (paste branch).
- Else treat as a path. Resolve to an absolute path.
  - If the resolved path is under `<root>/` → REFUSE. Tell the user: "That file is already in the repo. Use `/x-wiki:compile <path>` directly — no point copying." Stop here.
  - Else continue to Step 3 (external file branch).

## Step 3 — Capture

### URL branch

1. WebFetch the URL with a prompt like: "Convert this page to clean markdown, preserving headings, lists, code blocks. Return only the markdown content; no commentary."
2. Pick a slug:
   - Prefer a slug derived from the page's `<title>` if extractable.
   - Else from the URL path's last segment.
   - kebab-case, ASCII, 1–50 chars.
3. If `<root>/docs/wiki/raw/articles/<slug>.md` exists or any file in that directory has the same `source-url` in its frontmatter, ask the user whether to overwrite. If declined, append `-YYYY-MM-DD` to the slug.
4. Build the frontmatter (see §4.1 of the spec, raw-file schema). Set `type: raw-article`, `source-url:` to the URL, `source-type: article`, `ingested:` to today's ISO date, `compiled: false`, `compiled-to: []`.
5. Write `<root>/docs/wiki/raw/articles/<slug>.md` with the frontmatter followed by the fetched markdown body.

### External file branch

1. Read the file. For PDFs, Claude Code's Read tool extracts text; rely on that. For binaries other than PDF, refuse with: "Can only ingest text-readable files. Convert it first."
2. Slug from the file's base name (without extension), kebab-case. Conflict → suffix with date.
3. Frontmatter: `type: raw-file`, `source-url: null`, `source-type:` pick one of `paper|transcript|code|doc` based on file extension/content, `ingested:` today, `compiled: false`, `compiled-to: []`.
4. Write `<root>/docs/wiki/raw/files/<slug>.md` with frontmatter + content.

### Paste branch

1. Scan the conversation backward for the largest user-supplied text block that isn't already part of a prior tool result. If you can't find a clear candidate, ask the user to re-paste the content.
2. Pick a 3–6 word title for the content via LLM reasoning. Slug = kebab-case of the title.
3. File name: `<YYYY-MM-DD>-<slug>.md`.
4. Frontmatter: `type: raw-paste`, `source-url: null`, `source-type: doc`, `ingested:` today, `compiled: false`, `compiled-to: []`.
5. Write `<root>/docs/wiki/raw/pastes/<filename>` with frontmatter + paste body.

## Step 4 — Report

Tell the user:
- What was saved and where (full path).
- The slug and approximate word count.
- The suggested next step: `/x-wiki:compile <that-path>`.

Do not run compile automatically.

## Edge cases

- URL that returns non-text (image, binary) → refuse with the WebFetch error.
- File path that does not exist → refuse with "file not found: …".
- Paste branch when the conversation has no large paste → ask the user to paste the content as the next message and re-run.
```

- [ ] **Step 2: Validate frontmatter**

Same eyeball check as Task 3 Step 2.

- [ ] **Step 3: Commit**

```bash
git add skills/ingest/SKILL.md
git commit -m "feat: /x-wiki:ingest skill (URL / external file / paste)"
```

---

## Task 5: `/x-wiki:compile` skill

**Files:**
- Create: `skills/compile/SKILL.md`

Per §3.3 of the spec. Processes raw/ items OR arbitrary in-repo files. In-repo files are read in place — never copied.

- [ ] **Step 1: Write `skills/compile/SKILL.md`**

```markdown
---
name: compile
description: |
  Synthesize wiki pages from a source file. Accepts a path to any file in the repo (raw/ item, design spec, README, ADR, code doc). Without arguments, processes all `raw/**` items with `compiled: false`. Re-running on the same path is idempotent — derived pages get updated, not duplicated. Use when the user says "compile", "synthesize pages", "process the source", or names a doc to extract knowledge from.
argument-hint: "[<path>]"
allowed-tools: Bash(git rev-parse:*) Bash(test:*) Read Write Edit Grep Glob
---

# /x-wiki:compile

You are synthesizing wiki pages from one or more source files.

`$ARGUMENTS` is either empty or a single path.

## Step 1 — Find the wiki

`<root>` = `git rev-parse --show-toplevel`. Confirm `<root>/docs/wiki/CLAUDE.md` exists; it auto-loads now. If not, stop and ask user to run `/x-wiki:init` first.

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

For each entity, target path is `<root>/docs/wiki/pages/<type>/<slug>.md`.

If the file doesn't exist:
- Write a new page using the template from `docs/wiki/CLAUDE.md` for that type.
- Frontmatter: `id`, `type`, `title`, `created` = today, `updated` = today, `status: active`, `tags: [...]` extracted from the source, `sources: [<repo-root-relative path to the source>]`. For type `source`, add `source-url`, `source-type`.

If the file exists:
- Edit the body to add new facts in the appropriate sections (Key facts / Main ideas / Related concepts).
- Bump `updated` to today.
- Add the source path to `sources:` if not already there.
- Do not remove existing content.

If two sources disagree on a fact, insert a callout block (see `docs/wiki/CLAUDE.md` compile rules) in both affected pages — never silently overwrite.

### 4e. Source-summary (raw sources only)

For raw sources, additionally create `<root>/docs/wiki/pages/source/<source-slug>-summary.md` using the source-summary template. `sources:` is `[<path to the raw file>]`.

Skip this step for in-repo sources — the original is already discoverable in the repo.

### 4f. Backlink audit

For each page created or updated in this pass:

1. Grep all of `<root>/docs/wiki/pages/**/*.md` for the page's exact `title:` (case-sensitive, whole-word match).
2. For each file that mentions the title:
   - Skip if the mention is already inside a markdown link `[...](...)`.
   - Skip if the mention is inside a fenced code block (` ``` … ``` `) or inline code (`` `…` ``).
   - At the first remaining occurrence, replace the bare word with a markdown link to the page (relative path from the editing file).
   - Do this at most once per file per page.

Stop early if a single page would produce more than 20 backlink additions across the wiki — flag it as suspicious in the report and ask the user before proceeding (likely a common-word collision).

### 4g. Stamp the raw frontmatter

If the source was a raw file (not in-repo): Edit its frontmatter — set `compiled: true` and `compiled-to:` to the list of pages just created/updated for it.

Do not touch in-repo source files.

## Step 5 — Regenerate `index.md`

Glob `<root>/docs/wiki/pages/**/*.md`. Group by type. For each group, list each page as `- [<title>](pages/<type>/<slug>.md) — <one-line summary from frontmatter or first body sentence>`. Overwrite `<root>/docs/wiki/index.md`.

Keep the header "# Wiki index" and the "regenerated by ... don't edit by hand" note from the template.

## Step 6 — Report

Tell the user:
- N pages created, M updated.
- K backlinks added.
- Any conflict callouts inserted, listed by file.
- Any backlink-audit warnings deferred for human review.

## Edge cases

- Source file exists but is empty → skip it and report.
- Source file references entities that share normalised titles with existing pages of a different type → prefer the existing type; do not duplicate across types.
- A page would exceed 2000 words after Edit → flag in the report, suggest splitting (don't auto-split).
```

- [ ] **Step 2: Validate frontmatter**

Open the file and verify by eye that:
- The `---` markers are on their own lines.
- `name`, `description`, `argument-hint`, `allowed-tools` are top-level YAML keys.
- The multiline `description` uses `|` block scalar so newlines are preserved literally.

If a YAML parser is available locally, run it (e.g. `python -c "import yaml; print(yaml.safe_load(open('skills/<this-skill>/SKILL.md').read().split('---')[1]))"`). Otherwise eyeball it.

- [ ] **Step 3: Commit**

```bash
git add skills/compile/SKILL.md
git commit -m "feat: /x-wiki:compile skill (raw and in-repo sources, idempotent)"
```

---

## Task 6: `/x-wiki:query` skill

**Files:**
- Create: `skills/query/SKILL.md`

Per §3.4 of the spec.

- [ ] **Step 1: Write `skills/query/SKILL.md`**

```markdown
---
name: query
description: |
  Answer a question using the wiki's pages, with citations. Writes the answer to `pages/queries/<date>-<slug>.md` and conversationally offers to promote it to a concept page. Use when the user says "query wiki", "ask the wiki", "what does the wiki say about X", or asks a question that might be covered by accumulated project knowledge.
argument-hint: "<question>"
allowed-tools: Bash(git rev-parse:*) Bash(mv:*) Read Write Edit Grep Glob
---

# /x-wiki:query

You are answering one question using the wiki's pages and saving the answer.

`$ARGUMENTS` is the verbatim question.

## Step 1 — Find the wiki

`<root>` = `git rev-parse --show-toplevel`. Confirm `<root>/docs/wiki/CLAUDE.md` exists. If not, stop with "run `/x-wiki:init` first".

## Step 2 — Extract terms

Identify 3–8 keyword terms from the question that are likely to appear in page bodies or titles. Strip stopwords. Include synonyms only if you're confident.

## Step 3 — Search

- For each term, grep `<root>/docs/wiki/pages/**/*.md` case-insensitively.
- Also glob pages whose frontmatter `tags:` overlap with question topics (use Grep with a pattern that matches `tags:.*<topic>`).
- Aggregate matched files, deduplicate, rank by occurrence count.

If aggregate is empty, stop. Tell the user: "Nothing in the wiki covers that. Try ingesting a source first." Do not write a query page in this case.

## Step 4 — Read top results

Read the top 5–10 ranked files in full. If you exceed 10 candidates, pick the top 10 by occurrence count; cite only files you actually read.

## Step 5 — Synthesize the answer

Compose a 1–3 paragraph answer. Cite specific pages inline using markdown links: `[Title](pages/concept/foo.md)`. Never claim something the cited pages don't support; if the wiki is silent or contradictory on a point, say so.

## Step 6 — Write the query-output page

Path: `<root>/docs/wiki/pages/queries/<YYYY-MM-DD>-<question-slug>.md`.

Slug from a 3–6 word condensation of the question, kebab-case.

Frontmatter (see `docs/wiki/CLAUDE.md`, query schema):
```yaml
id: <YYYY-MM-DD>-<slug>
type: query
title: <human-readable short form>
created: <today ISO>
status: filed
tags: [<topics>]
question: "<verbatim original question>"
informed-by:
  - <relative path to each cited page>
```

Body: the answer composed in Step 5.

## Step 7 — Reply and invite promotion

Return the answer to the user in chat. End your reply with one short line like:

> "Saved to `pages/queries/<filename>.md`. Want me to promote this into `pages/concept/<slug>.md`?"

Then stop. Do NOT pre-emptively promote.

## Step 8 — Handle promotion (only on user agreement)

If the user agrees in the next turn:

1. Move the file using Bash: `mv <src> <dst>`. Works on POSIX and on Windows via Git Bash (the Bash tool's default backend on Windows).
2. Edit the moved file's frontmatter:
   - `type: query` → `type: concept`
   - `status: filed` → `status: active`
   - Drop `question:` and `informed-by:` fields.
   - Add `updated:` = today.
   - Add `sources:` set to the same list that was in `informed-by:`.
3. Rename the file to `pages/concept/<slug>.md` (drop the date prefix).
4. Optionally run a follow-up backlink audit for the new concept page (same algorithm as compile step 4f).

## Edge cases

- Empty grep results → no page written, conversational reply only.
- Question is multi-part — split mentally, answer each, cite per part. Don't write multiple query pages.
- User asks the same question twice — the second query gets its own dated file. That's OK; lint will surface near-duplicates if it becomes a problem.
```

- [ ] **Step 2: Validate frontmatter**

Open the file and verify by eye that:
- The `---` markers are on their own lines.
- `name`, `description`, `argument-hint`, `allowed-tools` are top-level YAML keys.
- The multiline `description` uses `|` block scalar so newlines are preserved literally.

If a YAML parser is available locally, run it (e.g. `python -c "import yaml; print(yaml.safe_load(open('skills/<this-skill>/SKILL.md').read().split('---')[1]))"`). Otherwise eyeball it.

- [ ] **Step 3: Commit**

```bash
git add skills/query/SKILL.md
git commit -m "feat: /x-wiki:query skill (search, synthesize, optional promote)"
```

---

## Task 7: `/x-wiki:lint` skill

**Files:**
- Create: `skills/lint/SKILL.md`

Per §3.5 of the spec.

- [ ] **Step 1: Write `skills/lint/SKILL.md`**

```markdown
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
```

- [ ] **Step 2: Validate frontmatter**

Open the file and verify by eye that:
- The `---` markers are on their own lines.
- `name`, `description`, `argument-hint`, `allowed-tools` are top-level YAML keys.
- The multiline `description` uses `|` block scalar so newlines are preserved literally.

If a YAML parser is available locally, run it (e.g. `python -c "import yaml; print(yaml.safe_load(open('skills/<this-skill>/SKILL.md').read().split('---')[1]))"`). Otherwise eyeball it.

- [ ] **Step 3: Commit**

```bash
git add skills/lint/SKILL.md
git commit -m "feat: /x-wiki:lint skill (read-only audit, errors vs warnings)"
```

---

## Task 8: End-to-end smoke test

Run the full pipeline against a throwaway test repo to catch integration bugs.

**Files:** none in this repo — the test happens in a separate directory.

- [ ] **Step 1: Install the plugin locally**

The exact install command depends on the current Claude Code plugin tooling. Try these in order:

1. `/plugin` slash command — see if there's an "Add local plugin" option pointing to this repo's directory.
2. Otherwise, follow `https://code.claude.com/docs/en/plugins` for the current local-install procedure.

Verify install by listing skills: type `/` in Claude Code and confirm `/x-wiki:init`, `/x-wiki:ingest`, `/x-wiki:compile`, `/x-wiki:query`, `/x-wiki:lint` appear in the menu.

- [ ] **Step 2: Set up a clean test repo**

```bash
mkdir /tmp/x-wiki-smoke && cd /tmp/x-wiki-smoke
git init
echo "# smoke" > README.md
git add . && git commit -m "init"
```

(On Windows: use `mkdir $env:TEMP\x-wiki-smoke; cd $env:TEMP\x-wiki-smoke; git init; ...`)

- [ ] **Step 3: Run `/x-wiki:init`**

Expected:
- `docs/wiki/{raw,pages}/...` created.
- `docs/wiki/CLAUDE.md`, `README.md`, `index.md` present.
- `.claude/rules/x-wiki.md` present.

If the rule file is not created, re-check Task 3 step 5.

- [ ] **Step 4: Run `/x-wiki:ingest <a-public-url>`**

Pick a small public article. Expected: `docs/wiki/raw/articles/<slug>.md` with frontmatter and the article's markdown.

Also try `/x-wiki:ingest /tmp/x-wiki-smoke/README.md` — expected: refusal with "use `/x-wiki:compile` instead" message.

- [ ] **Step 5: Run `/x-wiki:compile`**

Expected: at least one page in `pages/concept/`, one in `pages/source/`. `raw/articles/<slug>.md` frontmatter now has `compiled: true` and `compiled-to:` populated. `index.md` lists the new pages.

- [ ] **Step 6: Run `/x-wiki:compile docs/wiki/README.md`**

(Or any other in-repo file.) Expected: pages created, sources entries point to the in-repo path (relative to repo root), README.md itself is unchanged.

- [ ] **Step 7: Run `/x-wiki:query "what is <a topic from the ingested article>"`**

Expected: an answer with at least one citation; a new file in `pages/queries/<date>-<slug>.md`; the reply ends with the promotion offer.

- [ ] **Step 8: Decline the promotion**

In the next message, say "no, leave it." Expected: query file stays where it is.

- [ ] **Step 9: Run `/x-wiki:query` again with a different question, accept promotion**

Expected: the query file moves to `pages/concept/<slug>.md`; frontmatter updated to `type: concept`, `status: active`, `sources:` populated from former `informed-by`, `question:` and `informed-by:` removed.

- [ ] **Step 10: Run `/x-wiki:lint`**

Expected: probably 0 errors. Maybe some warnings about underlinked pages (the smoke test has very few pages). If errors, fix the underlying skill, re-test.

- [ ] **Step 11: Note any issues in the plugin README**

Add a "Known limitations" section to the plugin's `README.md` capturing any rough edges the smoke test surfaced (anything that worked but felt wrong, manual prompts that should have been automatic, etc.).

- [ ] **Step 12: Commit**

```bash
cd /path/to/x-wiki/plugin/repo  # back to C:\projects\tssd\x
git add README.md
git commit -m "docs: known limitations from smoke test"
```

---

## Post-completion

After Task 8 commits, the plugin is functional end-to-end. Consider as follow-up (NOT part of this plan):

- Convert `/x-wiki:lint` to `context: fork, agent: Explore` (see §7 of the spec).
- Add a marketplace.json for easier sharing.
- Set up CI to lint the plugin's own skill frontmatter on commit.
