# Design: `x-wiki` plugin — persistent knowledge wiki

**Date:** 2026-05-11
**Status:** Approved (brainstorming)
**Inspired by:** [ekadetov/llm-wiki](https://github.com/ekadetov/llm-wiki) — same idea, different shape (no Obsidian, no external deps, skill-per-operation, single wiki per repo).

---

## 1. Goal

A Claude Code plugin that turns any git repository into a growing knowledge base under `docs/wiki/`. Every operation is its own skill. The wiki is plain markdown — readable and editable like code. No external dependencies.

---

## 2. Architecture

### 2.1 Plugin layout

```
x-wiki/                              ← plugin (a repo or ~/.claude/plugins/x-wiki/)
├── .claude-plugin/
│   └── plugin.json                  ← manifest (name=x-wiki, version, description)
├── skills/
│   ├── init/SKILL.md                → /x-wiki:init
│   ├── ingest/SKILL.md              → /x-wiki:ingest <url|path|->
│   ├── compile/SKILL.md             → /x-wiki:compile [<path>]
│   ├── query/SKILL.md               → /x-wiki:query "<question>"
│   ├── lint/SKILL.md                → /x-wiki:lint
│   └── _shared/                     ← reference files (frontmatter-schemas.md, compile-guide.md)
└── README.md
```

**Skill-per-operation:** each `SKILL.md` automatically becomes `/x-wiki:<name>` plus auto-activation based on `description` triggers. No `commands/` files (deprecated — merged into skills).

**No** `commands/`, `hooks/`, `scripts/`, binaries, or install-deps.

**Skill coordination** — two files created by `/x-wiki:init`:
1. `<repo>/.claude/rules/x-wiki.md` — short (~30 lines) global rule WITHOUT `paths:`. Loads every session in the repo. Tells any Claude/skill that the wiki and its commands exist.
2. `<repo>/docs/wiki/CLAUDE.md` — detailed frontmatter schemas, naming rules, link rules, compile rules. Auto-loads when Claude reads any file under `docs/wiki/**`.

### 2.2 Repo root and wiki discovery

All skills resolve the **repo root** the same way: `git rev-parse --show-toplevel`. Everything below is anchored to this root, not to CWD.

The **wiki root** is always `<repo-root>/docs/wiki/`. Skills check that `<repo-root>/docs/wiki/CLAUDE.md` exists; if not, they error: "run `/x-wiki:init` first" (except `/x-wiki:init` itself, which uses the absence to confirm it can scaffold).

Outside a git repo, `git rev-parse` fails; the skill falls back to CWD as the repo root and warns the user.

### 2.3 `docs/wiki/` layout

```
docs/wiki/
├── CLAUDE.md           ← rules and schemas for Claude (auto-loads when working inside)
├── README.md           ← navigation for humans
├── index.md            ← flat list of all pages by type
├── raw/                ← immutable EXTERNAL sources (frontmatter compiled: false/true)
│   ├── articles/       ← downloaded URLs
│   ├── files/          ← copies of files from OUTSIDE the repo (PDFs etc.)
│   └── pastes/         ← inline pastes from chat
└── pages/              ← synthesized pages (4 types = 4 subdirs)
    ├── concept/
    ├── person/
    ├── source/         ← source-summary files
    └── queries/        ← /x-wiki:query results (filed → promoted = moved into concept/)
```

**Subdirs by type, not flat:** simpler grep filters, cleaner glob patterns, easier visual navigation. The `type:` in frontmatter must match the subdirectory.

**In-repo sources are NOT copied into `raw/`.** They stay where they are; `sources:` in pages points to the original path. Use `/x-wiki:compile <path>` directly for any in-repo file. Only external sources (URL, paste, file outside the repo) go through `/x-wiki:ingest` into `raw/`.

---

## 3. Skill workflows

### 3.1 `/x-wiki:init`

**Triggers:** "init wiki", "create wiki", "setup knowledge base"
**Args:** none

**Algorithm:**
1. Resolve repo root via `git rev-parse --show-toplevel`. Not a git repo → ask whether to use CWD as the root.
2. If `<repo-root>/docs/wiki/` exists → error "already initialized".
3. Create the layout under `<repo-root>/`: `docs/wiki/{raw/{articles,files,pastes},pages/{concept,person,source,queries}}` + `.gitkeep` in empty dirs.
4. Write `<repo-root>/docs/wiki/CLAUDE.md`, `<repo-root>/docs/wiki/README.md`, `<repo-root>/docs/wiki/index.md`.
5. Ensure `<repo-root>/.claude/rules/` exists (mkdir -p). Write `<repo-root>/.claude/rules/x-wiki.md`. If the file already exists — do not overwrite, warn the user.
6. Final message: tell the user where the wiki was created and suggest first steps (`/x-wiki:ingest <url>` for an external source, `/x-wiki:compile <path>` for a doc already in the repo).

**Tools:** Bash, Write, Read.

### 3.2 `/x-wiki:ingest`

External sources only. For files already in the repo → use `/x-wiki:compile <path>` directly (no copy).

**Triggers:** "ingest", "save to wiki", "save source", "add to wiki"
**Args:** `<url|path|->` — URL, path to a file **outside the repo**, or `-` (inline paste)

**Algorithm:**
1. Resolve repo root and confirm wiki exists (see §2.2).
2. Classify the argument:
   - `^https?://` → URL. WebFetch → `raw/articles/<slug>.md`.
   - Path argument → resolve to absolute path. If it resolves under `<repo-root>/` → refuse with hint: "this file is already in the repo, use `/x-wiki:compile <path>` directly — no point copying". Otherwise (file outside the repo) → Read → `raw/files/<basename>.md`.
   - `-` → use the last large paste from chat context. The skill picks a title from the content via LLM. → `raw/pastes/<date>-<slug>.md`.
3. Slug from title/URL/filename, kebab-case. Conflict → suffix with date.
4. Write with raw-file frontmatter (see §4.1).
5. Tell the user what was saved and suggest `/x-wiki:compile`.

**Tools:** Read, Write, WebFetch, Bash.
**Edge:** URL duplicate (same `source-url` already in raw/) → warn, ask whether to overwrite. PDF → Read extracts text.

### 3.3 `/x-wiki:compile`

Accepts any file path — both `raw/` items and arbitrary in-repo files (spec, README, ADR, code).

**Triggers:** "compile", "process sources", "synthesize pages"
**Args:** `[<path>]`
- Path to a raw file → process, set `compiled: true`, fill `compiled-to:`.
- Path to any other in-repo file → process "as is", WITHOUT modifying that file. `sources:` in the created pages contains this path.
- No argument → glob `raw/**` for `compiled: false` (only raw/ is auto-tracked; in-repo files require an explicit path).
- Idempotent: re-running on the same path updates derived pages instead of duplicating them.

**Algorithm:**
1. Resolve repo root and confirm wiki exists (see §2.2). `docs/wiki/CLAUDE.md` auto-loads.
2. Build the file list per the args above.
3. For each source file:
   - Read → extract entities/facts (LLM reasoning, no invention).
   - For each entity: page exists at `pages/<type>/<slug>.md` → Edit (add facts in the right sections, bump `updated`, extend `sources`); doesn't exist → Write using the type template.
   - **Only for raw/ sources:** also create `pages/source/<slug>-summary.md` so the external content has a durable in-wiki representation. For in-repo sources, skip the source-summary — the original is already searchable in the repo, no need to duplicate.
   - **Backlink audit:** grep `pages/**/*.md` for mentions of any new page title. Constraints: (a) case-sensitive whole-word match against the exact `title:` from frontmatter, (b) skip occurrences already inside a markdown link `[...](...)` or inside a fenced/inline code block, (c) link only at the first qualifying occurrence per file.
   - If the source is a raw file: bump its frontmatter `compiled: true`, fill `compiled-to: [...]`. If it's an in-repo file: do not modify it. Idempotency comes from `id` collision detection — re-compile of the same path updates the same pages, no duplicates.
4. Regenerate `index.md`.
5. Report: N pages created, M updated, K backlinks added.

**Tools:** Read, Write, Edit, Grep, Glob.
**Edge:** factual conflict between sources → callout block (see §4.4).

### 3.4 `/x-wiki:query`

**Triggers:** "query wiki", "ask the wiki", "what does the wiki say about X"
**Args:** `<question>`

**Algorithm:**
1. Resolve repo root and confirm wiki exists (see §2.2).
2. Pull keyword terms from the question.
3. Grep `pages/**/*.md` for terms + glob by frontmatter tags if the question names topics.
4. Read top-N (N=5–10) most relevant pages.
5. Generate the answer with citations like `[Title](pages/concept/foo.md)`. Insufficient data → say so honestly: "not enough — ingest X first".
6. Write `pages/queries/<date>-<slug>.md` with the query frontmatter (see §4.1).
7. Return the answer in chat. End the reply with a conversational invite — "want me to promote this to `pages/concept/`?" — and only act on it if the user agrees in the next turn. Promotion = move file via Bash (`mv` / `Move-Item`), change `type: concept`, `status: active`, drop `question` and `informed-by` fields.

**Tools:** Read, Write, Grep, Glob, Bash (for the optional promotion move).
**Edge:** empty grep → say honestly "no data; nothing written".

### 3.5 `/x-wiki:lint`

**Triggers:** "lint wiki", "audit wiki", "check the wiki"
**Args:** none

**Algorithm:**
1. Resolve repo root and confirm wiki exists (see §2.2).
2. Checks (each marked **error** or **warning** in the report):
   - **Dead links (error):** every `[text](path)` in page bodies points to an existing file.
   - **Dead sources (error):** every entry in `sources:` frontmatter (resolved relative to repo root — see §4.1) points to an existing file.
   - **Orphan pages (warning):** pages (except `index.md` and `pages/queries/*`) without any incoming link from another page.
   - **Frontmatter (error):** required fields present per type; `type:` matches the subdirectory.
   - **Underlinked (warning):** concept pages with fewer than 3 outgoing links to other pages. `status: draft` exempt — drafts are still under construction.
   - **Stale (warning):** `status: active` + `updated` older than 90 days.
3. Report findings with file paths grouped by severity. **Does not fix anything automatically.**

**Tools:** Read, Grep, Glob.

---

## 4. Schemas and rules (contents of `docs/wiki/CLAUDE.md`)

### 4.1 Frontmatter

**Base fields (all 4 page types):**
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

**`concept`** — no extra fields.
**`person`** — no extra fields.

**`source`:**
```yaml
source-url: https://...
source-type: article      # article | paper | transcript | code | doc
```

**`query`:**
```yaml
question: "<verbatim original>"
informed-by:
  - pages/concept/foo.md
status: filed             # filed | promoted
```
(base: only `id`, `type`, `title`, `created`, `status`, `tags`)

**Raw files (in `raw/`):**
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

In-repo files used as sources are NOT modified by the plugin — they need no special frontmatter. They appear in `sources:` arrays of pages by path.

### 4.2 Naming

- Slug = kebab-case, ASCII or transliterated, 1–50 chars.
- Conflict → suffix with date: `pods.md` taken → `pods-2026-05-11.md`.
- Query pages: always `<date>-<slug>.md`.
- The subdirectory holds pages of the corresponding `type`: `concept/` → `type: concept`, `person/` → `type: person`, `source/` → `type: source`, `queries/` → `type: query`. Any other combination is a lint error.

### 4.3 Link rules

- Plain markdown `[text](relative/path.md)`. No `[[wikilinks]]`.
- Paths relative to the file containing the link.
- A concept page must have ≥3 outgoing links (enforced by `/x-wiki:lint`).
- **Backlink audit during compile is mandatory.**
- Links to `raw/` are allowed only in the `sources:` frontmatter field, never in body text.

### 4.4 Compile rules

- **No invention.** Every claim must trace back to a source listed in `sources:`. If a source does not support a claim, leave it out.
- Concept page length: 800–2000 words. Larger → split into sub-pages and link.
- Source-summary length: 300–600 words.
- Factual conflicts between sources — do not silently overwrite. Insert a callout block in both affected pages:
  ```
  > ⚠️ Conflict: [source A](../source/a-summary.md) claims X. [source B](../source/b-summary.md) claims Y.
  ```
- Update vs create: if a page with the same id exists → Edit (don't recreate, don't duplicate).

### 4.5 Page body templates (recommended, not strict)

**Concept / person:**
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

**Source-summary:**
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

**Query output:**
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

---

## 5. Contents of `<repo>/.claude/rules/x-wiki.md`

```markdown
# Project knowledge wiki

This repository has an indexed knowledge wiki at `docs/wiki/`.
- Synthesized pages: `docs/wiki/pages/` (subdirs: concept/, person/, source/, queries/)
- Captured external sources: `docs/wiki/raw/` (articles/, files/, pastes/)
- Entry point for humans: `docs/wiki/index.md`

If the user asks a question that might be covered by accumulated project knowledge,
prefer the wiki first: grep/read `docs/wiki/pages/` directly, or invoke
`/x-wiki:query "<question>"` for a synthesized answer with citations.

## Adding repository docs to the wiki

When you (or another skill) finalize a document anywhere in this repo that
captures durable knowledge worth searching later — a design spec, plan, ADR,
README, architecture note, postmortem, or similar — run:

    /x-wiki:compile <path-to-doc>

This reads the file in place (no copy into `raw/`) and synthesizes concept
pages with `sources: [<path-to-doc>]`. Re-running on the same path updates the
derived pages instead of duplicating them.

Use `/x-wiki:ingest` only for external sources — URLs, pastes, or files from
outside the repo. In-repo files should go through `/x-wiki:compile` directly.

Caveat: derived pages can become stale if the source doc later diverges from
the implementation. `/x-wiki:lint` flags `status: active` pages older than 90
days; re-run `/x-wiki:compile <path>` after major edits to the source.

## Maintenance commands (plugin `x-wiki`)

- `/x-wiki:ingest <url|path|->` — capture an external source (URL, paste, or file from outside the repo) into raw/
- `/x-wiki:compile [path]` — synthesize pages from any source file in the repo, or from unprocessed raw/ items if no argument is given
- `/x-wiki:query "<question>"` — search the wiki and answer with citations
- `/x-wiki:lint` — audit links, orphan pages, stale frontmatter

Detailed frontmatter schemas, naming conventions, and link rules are in
`docs/wiki/CLAUDE.md`, which auto-loads when Claude works with files under `docs/wiki/`.
```

---

## 6. What we explicitly do NOT do

| Don't do | Why |
|---|---|
| `commands/` directory | Skill auto-publishes `/x-wiki:<name>`. Duplicating is pointless. |
| `hooks/` | No external dependencies → nothing to install. |
| `scripts/` | Built-in Claude Code tools (Read/Write/Edit/Grep/Glob/WebFetch/Bash) cover everything. Cross-platform for free. |
| `qmd` / embeddings / sqlite-vec | Grep + LLM reasoning is enough. No binaries. |
| Obsidian, wikilinks `[[...]]` | Plain markdown — clickable in GitHub/VSCode/any md viewer. |
| Multi-wiki per repo | One wiki per repo. Can extend later without breaking. |
| Git auto-commit | The wiki lives in the user's repo; auto-commits trash staging during parallel work. |
| `log.md` | State = files. Git history + frontmatter cover it. |
| `/x-wiki:remove` | Remove by hand. A destructive op should not be one click. |
| Translation between languages | Compile preserves source language. |
| Auto-fix in `/x-wiki:lint` | Lint only reports; fixing is the user's call. |
| Copying in-repo files into `raw/` | Creates duplicates that drift from the original. `sources:` references the original path instead. |
| Coupling to any specific other plugin in the global rule | The rule speaks in terms of "any document worth searching later", not "after superpowers:brainstorming". |

---

## 7. Open questions for the implementation plan

- Exact `plugin.json` shape — verify against live docs at writing-plans time.
- PDF handling (Read tool extracts text directly — verify limits).
- Page body templates — inline in compile's SKILL.md, or extract to `_shared/templates/`.
- Inline-paste detection (`-` argument) — how the skill identifies "the last large paste from chat". May simplify by requiring an explicit second argument.
- Cross-platform: walk-up to `docs/wiki/` — Git Bash, PowerShell, plain Linux — likely all work via Glob/Read, but verify.
- Cross-platform file move for promotion (`/x-wiki:query` step 7) — `mv` on POSIX vs `Move-Item` on PowerShell vs `git mv`. The skill should pick the right Bash invocation based on the active shell.
- Backlink audit safety — beyond the constraints listed in §3.3 step 3, consider also a maximum links-added-per-compile threshold to avoid runaway changes when a new page title happens to be a common word.
- Idempotency of slug generation across compile runs. Two compiles of the same source could pick slightly different titles for the same concept ("Kubernetes Pods" vs "Kubernetes pods") and generate different slugs, defeating dedup. Mitigation: before creating a new page, normalise the candidate title (lowercase, strip punctuation, collapse spaces) and check `pages/<type>/*` for an existing page whose normalised title matches. Match → Edit it; no match → Write new. Decide whether to encode this in CLAUDE.md or only in the compile skill.
- Subagent execution (`context: fork`) for heavier skills. Sequential pipeline of skills is fine; the question is whether to isolate any of them into a forked context to keep the parent conversation lean. Current thinking:
  - `init`, `ingest` — inline (trivial).
  - `lint` — strong candidate for `context: fork, agent: Explore` (pure read-only audit; returns a report). First skill to convert.
  - `query` — candidate for two-phase: forked `Explore` does research + drafts the answer; parent writes `pages/queries/...md` and handles the promotion prompt. Adds complexity; defer unless the parent context noticeably suffers.
  - `compile` — heaviest in tokens but also the most stateful (writes many files, runs backlink audits, regenerates `index.md`). Parallel-per-file is unsafe (race on shared concept pages). Fork-the-whole-operation is doable but harder to validate; defer until after `lint` and `query` patterns are settled.
  - MVP: keep everything inline. Revisit after first real use.
