# Design: `pwiki` CLI — deterministic mechanics for p-wiki skills

**Date:** 2026-05-14
**Status:** Drafted (brainstorming)
**Targets:** `plugins/p-wiki` v1.0.0 (major bump from v0.1.0)

---

## 1. Goal

A Node CLI bundled inside the `p-wiki` plugin, entry point `tools/pwiki.mjs`. Replaces the mechanical parts of every existing skill — page creation from templates, frontmatter mutation, ranked full-text search, lint checks — with deterministic CLI commands. LLM-driven parts (reading source material, synthesizing entity bodies, deciding when to promote a query) stay in the skills.

### 1.1 Pains addressed

- **Token cost.** `lint` reads every page; `compile` greps every page during the backlink audit; `query` greps for several terms and re-reads top-10. Moving the mechanical scans to CLI removes the read/grep cycles from the LLM token budget.
- **Determinism.** The same wiki state must produce the same page creations, the same slug-conflict decisions, the same search ranking, and the same lint report — regardless of which Claude session runs them.

### 1.2 Non-goals

- Replace LLM judgment about content (entity extraction, conflict callouts, body sectioning).
- Provide a delete command (users remove pages via `git rm` themselves).
- Build an on-disk index (we run searches on the fly).
- Cover backlink audit and `index.md` regeneration in v1 — see §8 (v2 scope).

---

## 2. Architecture

### 2.1 Layout inside the plugin

```
plugins/p-wiki/
├── tools/
│   ├── pwiki.mjs                ← single CLI entry point; dispatches through Destination interface
│   ├── lib/
│   │   ├── destination.mjs      ← Destination interface contract + resolver (§2.6)
│   │   ├── destinations/
│   │   │   └── fs.mjs           ← FS implementation of Destination (only one in v1)
│   │   ├── paths.mjs            ← wiki root discovery, path normalization
│   │   ├── yaml.mjs             ← minimal YAML parse/serialize for our schema
│   │   ├── fm.mjs               ← frontmatter read/write, body extraction
│   │   ├── schema.mjs           ← per-type frontmatter schema and template body
│   │   ├── slug.mjs             ← kebab-case slug + conflict resolution
│   │   ├── search.mjs           ← tokenizer + BM25-lite ranking (used by FS destination)
│   │   └── lint.mjs             ← all lint checks (used by FS destination)
│   └── __tests__/               ← node:test unit + integration tests
└── skills/                      ← existing skills, updated to call the CLI
```

### 2.2 Dependencies

**Zero npm dependencies.** Node 18+ stdlib only (`node:fs`, `node:path`, `node:process`, `node:test`). Rationale:

- Plugins distribute as git checkouts; `npm install` is not part of `/plugin install`. Either we vendor deps or we avoid them. Avoiding is simpler.
- Our YAML subset is narrow: key/value scalars, flat string arrays, no anchors / refs / block scalars. A hand-rolled parser is ~80 lines.
- BM25-lite ranking with simple tokenization (lowercase, strip punctuation, split on whitespace, drop a short English + Russian stopword list) is ~100 lines. No stemming.

### 2.3 Skill ↔ CLI contract

Skills invoke the CLI via `Bash`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" <command> [args] --format=json
```

Per skill `allowed-tools` gets `Bash(node*)` added; the rest of the existing `allowed-tools` (Read, Edit, Write, etc.) stays for body editing and chat interaction.

**stdout / stderr / exit code conventions:**

- `stdout`: JSON (`--format=json`, default for skill calls) or plain text (`--format=text`, used by `lint` when the skill wants to show the report verbatim to the user).
- `stderr`: diagnostic messages, `--verbose` traces. Silent on success.
- `exit 0` — success.
- `exit 1` — user/environment error (bad args, missing file). Skill propagates stderr to the user and stops.
- `exit 2` — schema violation or conflict the caller may resolve (slug taken, promotion target exists). JSON body carries enough detail for the skill to ask the user.
- `exit 3` — internal CLI error.

CLI output paths are **opaque strings** to the skill — never absolute filesystem paths. For v1's FS destination they are repo-root-relative POSIX paths (`docs/wiki/pages/concept/foo.md`). Other destinations (§2.6, §8) may use different shapes; the skill passes the string through to the user or back to the CLI without parsing it.

### 2.4 Wiki discovery

CLI walks up from `process.cwd()` until it finds `docs/wiki/CLAUDE.md`. No `git rev-parse` inside the CLI — skills already run `git rev-parse --show-toplevel` before calling the CLI, and the working directory is normally at repo root anyway. If the CLI can't find a wiki: `exit 1` with "not inside a p-wiki repo".

### 2.5 Schema source of truth

`tools/lib/schema.mjs` becomes the canonical frontmatter schema for the plugin — it is what `new`, `set`, `promote`, and the frontmatter lint check enforce at runtime. `docs/wiki/CLAUDE.md` (the auto-loaded LLM-facing schema doc) is human/LLM documentation, kept in sync by hand. If `CLAUDE.md` and `schema.mjs` disagree about a field's shape, that is a maintainer bug — `schema.mjs` is authoritative for everything the CLI does.

### 2.6 Destination interface

`pwiki.mjs` does not call FS code directly. It resolves a `Destination` implementation via `tools/lib/destination.mjs` and dispatches each command through it. In v1 only one implementation exists — `destinations/fs.mjs` — and the resolver always returns it. This seam exists so v2 can add a Confluence backend additively (see `2026-05-14-confluence-destination-sketch.md`) instead of as a rewrite of `pwiki.mjs`.

The interface is the union of the operations CLI commands need to perform on the wiki:

```
Destination {
  // Discovery / state
  resolveRoot()                    → { rootPath, kind: "fs" | ... }

  // Pages
  pageExists({ type, slug })       → boolean
  readPage({ type, slug } | path)  → { frontmatter, body, path }
  writePage({ type, slug, frontmatter, body, onConflict }) → { path, id, slug, created }
  mutatePage(path, mutations)      → { path, changed[], noop }
  movePage(fromPath, toPath)       → void
  listPages({ types?, in? })       → [{ path, frontmatter }]

  // Search and lint operate over the destination's universe
  search(query, options)           → { total, results[] }
  lint(options)                    → { errors{}, warnings{}, totals }
}
```

`destinations/fs.mjs` implements every method against the filesystem. All FS-specific code — path resolution, `fs.writeFile`, BM25 over file bodies, on-disk lint checks — lives behind this interface. Modules `paths.mjs`, `yaml.mjs`, `fm.mjs`, `slug.mjs`, `search.mjs`, `lint.mjs` are FS-implementation helpers, imported by `destinations/fs.mjs`.

**Resolver in v1:** reads no configuration; always returns the FS destination after locating the wiki root via `paths.mjs`. v2 will extend the resolver to inspect `docs/wiki/` config and return either FS or Confluence.

**No leaky paths.** Methods that produce or consume paths (`readPage`, `movePage`) keep the path shape opaque to `pwiki.mjs` — the CLI passes paths through to JSON output but does not parse them. For v1 paths are repo-root-relative POSIX strings; v2 may use other shapes (e.g. synthetic `confluence://page/<id>` URLs) and `pwiki.mjs` does not need changes.

This is the only architectural concession v1 makes for v2. Total addition: one interface file plus moving the FS code into `destinations/fs.mjs`. No HTTP, no Confluence code, no auth in v1.

---

## 3. Commands

### 3.1 `pwiki new <type> [options]`

Creates a new page from a template.

`<type>` ∈ `concept | person | source | query | raw-article | raw-file | raw-paste`.

| Option | Notes |
|---|---|
| `--title <str>` | Required. Slug derives from it unless `--slug` is given. |
| `--slug <str>` | Override derived slug. |
| `--tags <t1,t2,...>` | Comma-separated. |
| `--source <path>` | Repo-relative source path; pushes into `sources:`. Repeatable. |
| `--source-url <url>`, `--source-type <type>` | For `source` and `raw-*`. |
| `--question <str>`, `--informed-by <path>` | For `query`. `--informed-by` repeatable. |
| `--ingested-from <stdin\|path>` | `-` reads body from stdin (used by `ingest` URL/paste branches). |
| `--on-conflict <fail\|date-suffix\|overwrite>` | Default `fail`. |

**Output:**

```json
{ "path": "docs/wiki/pages/concept/foo.md", "id": "foo", "slug": "foo", "created": true }
```

**Exit codes:** 0 on success, 2 on slug conflict (JSON body includes `existing-path` and proposed `date-suffix-slug`), 1 on bad args.

### 3.2 `pwiki set <path> [options]`

Idempotent frontmatter mutation. Never touches the body.

| Option | Behavior |
|---|---|
| `--field <name>=<value>` | Set scalar. Repeatable. |
| `--add-tag <t>` / `--remove-tag <t>` | Modify `tags:`. |
| `--add-source <path>` | Dedup-push into `sources:`. |
| `--add-informed-by <path>` | For query. |
| `--add-compiled-to <path>` | For raw. |
| `--bump-updated` | Set `updated:` to today. |
| `--mark-compiled` | Set `compiled: true`. |

**Output:**

```json
{ "path": "...", "changed": ["updated", "sources"], "noop": false }
```

**Exit:** 0 (including noop), 1 (file not readable), 2 (schema violation — e.g. setting a field disallowed for the page's type).

### 3.3 `pwiki promote <path> --to <type>`

v1 supports only `--to concept` (query → concept).

Algorithm:

1. Read source frontmatter, verify `type: query`. Capture the `informed-by:` list now — it is consumed in step 5 before being dropped in step 6.
2. Compute target path: strip leading `YYYY-MM-DD-` from slug; target = `pages/concept/<slug>.md`.
3. If target exists → exit 2 with `existing-path` in JSON.
4. `fs.rename` source → target.
5. Compute the new `sources:` array: read each page listed in the captured `informed-by:`, take the union of their `sources:` arrays, dedup, sort.
6. Transform frontmatter in place:
   - `type → concept`
   - `status → active`
   - drop `question:`, drop `informed-by:`
   - add `updated:` = today
   - set `sources:` to the array computed in step 5.

**Output:**

```json
{ "from": "pages/queries/2026-05-14-foo.md", "to": "pages/concept/foo.md", "sources": ["raw/articles/x.md"] }
```

### 3.4 `pwiki search "<query>" [options]`

Deterministic ranked search.

| Option | Notes |
|---|---|
| `--type <t1,t2,...>` | Restrict to types. Default all. |
| `--tags <t1,t2,...>` | Require intersection with frontmatter `tags:`. |
| `--in <pages\|raw\|all>` | Default `pages`. |
| `--limit <N>` | Top N. Default 10. |
| `--snippet <true\|false>` | Return a body excerpt around the highest-scoring match. Default true. |

**Ranking:** BM25-lite over body. Title boost ×3, tag-match boost ×2. Tokenization: lowercase, strip punctuation, split on whitespace, drop a short stopword list (English + Russian).

**Output:**

```json
{
  "query": "kafka partitioning",
  "total": 23,
  "results": [
    { "path": "pages/concept/kafka-partitioning.md", "title": "Kafka partitioning",
      "type": "concept", "tags": ["streaming"], "score": 5.42,
      "snippet": "...consumer group rebalances when **kafka** topics change **partitioning**..." }
  ]
}
```

**Exit:** always 0. Empty result = `{ "total": 0, "results": [] }`.

### 3.5 `pwiki lint [options]`

| Option | Notes |
|---|---|
| `--format <text\|json>` | Default `text`. |
| `--severity <error\|warning\|all>` | Default `all`. |

JSON output is grouped by check key (`dead-links`, `dead-sources`, `frontmatter`, `orphan-pages`, `underlinked`, `stale`), each value is an array of finding records. Text output matches the format the existing `lint` skill already emits.

**Exit:** always 0 — `lint` reports, never decides. The skill shows the output to the user regardless of severity counts.

---

## 4. Skill migration

Every existing skill except `init` gets partial CLI conversion. The skills keep their slash-command names and arguments; only their internals change.

| Skill | Migrated to CLI | Stays in skill |
|---|---|---|
| `init` | `node --version` sanity check (new step 0) + add CLI usage notes to the `wiki-claude-md.template.md` template | All scaffolding, template copying, `.claude/rules/p-wiki.md`, final message |
| `ingest` | `pwiki new raw-article \| raw-file \| raw-paste` (file creation, frontmatter, slug-conflict handling from current step 3) | WebFetch, external file read, branch selection (url/file/paste), body content |
| `compile` | `pwiki new <type>` for new entities; `pwiki set <path> --bump-updated --add-source=...` for existing pages; `pwiki set <raw-path> --mark-compiled --add-compiled-to=...` to stamp raw frontmatter | Entity extraction, body sectioning, conflict callouts, **backlink audit (v2)**, **`index.md` regeneration (v2)** |
| `query` | `pwiki search "<q>" --format=json` (replaces grep + occurrence count); `pwiki new query --question=...` to write the query page; `pwiki promote <path> --to=concept` | Reading top results, synthesizing the answer, user-facing reply, decision to promote |
| `lint` | `pwiki lint --format=text` — entire body of work | Thin wrapper: invoke CLI, pass output to user, append the "Run `/p-wiki:compile` then re-lint" line |

---

## 5. Error handling at the skill boundary

| Exit | Skill response |
|---|---|
| 0 | Parse JSON, continue. |
| 1 | Forward stderr to chat, stop. |
| 2 — slug conflict (`ingest`, `compile`) | Read `existing-path` from JSON, ask user how to proceed (matches today's prompts: overwrite vs. date-suffix). Retry CLI with `--on-conflict=overwrite` or `--on-conflict=date-suffix`. |
| 2 — promote conflict (`query`) | Tell user "a concept page already exists at `<existing-path>`" (matches today's behavior). |
| 3 | Forward stderr with note to file an issue against the plugin. |

`lint` never branches on exit code — always 0.

---

## 6. Testing

Three layers, all running under existing `npm test` and `npm run validate`:

1. **Unit tests** in `plugins/p-wiki/tools/__tests__/`, written in TypeScript (`.test.ts`) using **vitest** — matches the existing marketplace test stack (`tests/marketplace.test.ts`, `tests/plugin-manifests.test.ts`, etc., all vitest + TypeScript). Cover:
   - YAML parser/serializer round-trip on every page type.
   - Slug generation and conflict resolution branches.
   - Frontmatter mutations (`set` flags, `promote` transform).
   - BM25-lite ranking on a tiny fixture corpus.
   - Each lint check on a synthetic wiki (built in `os.tmpdir()` per test).
   - `destinations/fs.mjs` against the `Destination` interface contract — split into two layers. A **shape conformance test** (every method present, argument validation behaves uniformly, output JSON matches §3 schemas) — this is the layer that v2 reuses for the Confluence destination. A **semantic test** for FS-specific behavior (slug-conflict resolution rules, BM25 ranking on a fixture corpus, lint check semantics over filesystem) — FS-only; v2 writes its own equivalent.
2. **Integration test:** sequence `pwiki new concept --title=Foo` → `pwiki search foo` (must find it) → `pwiki lint` (must not flag the new page) → `pwiki promote` on a synthetic query page (must move and transform). The test spawns `node pwiki.mjs` subprocesses against a tmp-wiki.
3. **Test discovery:** add a `vitest.config.ts` at repo root that points vitest at both `tests/` (existing) and `plugins/**/tools/__tests__/` (new). Update the `package.json` `test` script accordingly (drop the inline `tests` arg, let the config drive discovery).

The current static validation of manifests, skills, and templates keeps running unchanged.

---

## 7. Backwards compatibility

- **Frontmatter schema:** unchanged. Existing wikis under `docs/wiki/` keep working without migration.
- **Templates in `_shared/templates/`:** unchanged except `wiki-claude-md.template.md`, which gains a short section on the CLI so future LLM sessions know it exists.
- **External skill API:** slash-command names, arguments, and `argument-hint`s do not change. Users see the same `/p-wiki:*` commands.
- **Environment requirement:** Node ≥ 18 in `PATH` is now required for any skill that runs CLI commands. `init` checks for it and refuses to scaffold if absent. This is the only breaking change relative to v0.1.0 and is the reason for the major bump.

Version bump: **v0.1.0 → v1.0.0**, justified by the new runtime requirement.

---

## 8. v2 scope (explicitly out of v1)

- **Confluence destination.** A second implementation of the `Destination` interface (§2.6) that stores the wiki in Confluence Cloud instead of the filesystem. Use case, architectural choice, and open questions captured in the companion sketch `2026-05-14-confluence-destination-sketch.md`. v1's job here is solely to define the seam (§2.6); v2 fills it. This is the reason v1 includes the Destination interface at all.
- `pwiki backlinks <path>` — backlink audit, replacing compile step 4f. Deferred because of edge cases: case-sensitive whole-word matching, skipping inline code / fenced code blocks / existing links, per-file dedup, the 20-link suspicion threshold.
- `pwiki index` — regenerate `docs/wiki/index.md` from frontmatter, replacing compile step 5.

All three are additive: introducing them does not break the v1 CLI surface. `backlinks` and `index` become new methods on the `Destination` interface; skill internals will be updated to call them when they ship. The Confluence destination implements the same interface and ships behind a `init`-time configuration switch (details in the v2 brainstorming session).
