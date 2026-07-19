# p-observe TUI — detail-pane enrichment

**Date:** 2026-07-19
**Status:** approved (design)
**Scope:** enrich the four master/detail tabs of the pobserve TUI (p-shed, p-tasks, p-wiki, p-graph) so the detail pane shows meaningful per-entity metadata that is currently collected nowhere.

## Problem

The TUI detail panes show almost nothing beyond an id, a status, and a replay of event lines:

- **p-shed job** — no `prompt`, no `model`. These live in `.pshed/jobs.yml`, which the adapter never reads (it reads only `logs/*.jsonl` and `state/*.json#lastExit`).
- **p-tasks task** — no `title`, no `description`. The adapter's `readTaskStates` extracts only `id → status`; the task body is discarded.
- **p-wiki page** — only a `conflict`/`raw` flag. The rich `docs/wiki/index.json` bundle (full frontmatter + body per page) is watched for mtime only, never parsed.
- **p-graph** — only `nodes/edges/files/drift` are rendered, even though `status --json` already returns `schema_version`, `indexed_sha`, and `fts`.

Root cause is uniform: **the data is never collected into the adapter snapshot**, so the renderer has nothing to show. It is a missing-data-collection gap, not a render regression.

## Shared architecture

The detail pane shows "what this entity is **now**", so the source of truth is each adapter's `status()` snapshot — not event `data` (events are point-in-time and backfill only replays today's log). This matches the existing pattern where `jobsList` already reads `status.pshed.jobs`.

Invariants preserved across all adapters:

- **Torn-read rule.** Every parse-on-change read catches parse errors, keeps the prior snapshot as baseline, and retries next tick (observed plugins write non-atomically).
- **Zero runtime deps.** No bare-package imports. YAML/JSON is read with Node built-ins + tolerant hand-written scanners (no importing p-shed's vendored js-yaml).
- **Read-only, no cross-plugin coupling beyond current contract.** p-graph stays on `status --json` only.

### Shared helper: tolerant scalar extractor

`jobs.yml` and `tasks.yml` are both `js-yaml.dump` output, so a scalar field is one of: a plain/quoted single-line value (`model: sonnet`, `title: "Do X"`), or a **block scalar** where the `key:` line's value is an indicator (`|`, `|-`, `>`, `>-`) and the content follows on the next more-indented lines. A naive `key: value` scan therefore captures `|-` instead of the prompt's first line.

Both the p-shed and p-tasks scanners use one shared helper (e.g. `firstScalarLine`) that, given a matched `key:` line: returns the inline value when it is not a block indicator; otherwise returns the first following indented content line (trimmed). Only the **first** content line is ever needed — detail panes truncate anyway. The helper never throws; on anything unexpected it returns an empty string.

Layout is unchanged: the master/detail split stays as-is and new fields are truncated to the detail width via `fit()`. (A full-width detail layout was considered and declined — not worth the complexity for this pass.)

## Component designs

### 1. p-shed — prompt + model

`status()` additionally reads `.pshed/jobs.yml` (path already exposed as `paths.pshedJobs`). Parsing uses a **tolerant zero-dep scanner** in the spirit of `readTaskStates`: walk lines, key per-job scalar fields (`prompt`, `model`, `schedule`, `enabled`, `timeoutSec`) to the enclosing `- id:` item, using the shared `firstScalarLine` helper for each field so block-scalar prompts yield their first content line (not the `|-` indicator).

- Known limitation: for a multi-line block-scalar `prompt`, only the **first line** is captured. Acceptable for a detail pane; documented, not hidden.
- Torn-read gate: `pshed status()` reads the filesystem fresh on every call (it already does so for the run/state dirs), so the adapter closure caches the last successfully-parsed jobs map in a `lastJobsMeta` variable; on a failed/torn parse `status()` returns that cached map instead of an empty one.
- `status()` return grows a `jobsMeta` map: `{ [id]: { prompt, model, schedule, enabled, timeoutSec } }`, merged alongside the existing `{ running, jobs }`.

`pshedBody` detail pane adds, after the existing `job:` / `state:` lines:
- `prompt:` — first line, `fit()`-truncated.
- `model:` — the job's model as written in `jobs.yml`; if the job has no `model` key, show `(inherits default)` **without** resolving the actual default value (resolving it would couple p-observe to p-shed's default-resolution logic — deliberately avoided).
- `schedule:` and `enabled:`.

### 2. p-tasks — title + description

`readTaskStates` is generalized to `readTasks`: same tolerant, torn-read-safe line scanner, but it also captures `title` and `description` per item via the shared `firstScalarLine` helper (so a block-scalar description yields its first line), still pairing fields within a list item.

- The adapter `baseline` changes from `Map<id, status>` to `Map<id, { status, title, description }>`. The diff/event logic (`task.added`/`task.status`/`task.removed`) still keys on `status` only, so events are unchanged — only the snapshot is enriched. The existing torn-read gate (`readNow` returning `{ok:false}` on empty/mid-line-truncated reads) is retained and now also protects the title/description capture.
- `status()` returns the per-task map including `title` and `description` (existing `counts` retained).

`ptasksBody` detail pane adds, after `task: id [status]`:
- `title` as a header line.
- `description` wrapped to the pane width, capped at ~4 lines.

### 3. p-wiki — T2 (frontmatter + summary + link graph)

`status()` parses `docs/wiki/index.json` (the bundle: `{ pages: [{ type, id, path, frontmatter, body }] }`). The adapter already tracks this file's mtime for `wiki.reindex`; we now parse it.

- Torn-read gate: `index.json` is rewritten non-atomically by reindex — on `JSON.parse` failure keep the previous parsed snapshot.
- Per page, derive: `title`, `type`, `tags`, `source`, `compiled`, `conflict-since` (from frontmatter); `summary` (first paragraph of `body`); `outlinks` (both `[[id]]` wikilinks and markdown links to `.md`); `backlinks` (one global pass over all pages' outlinks per scan); `orphan` flag (no inbound and no outbound links).
- **Join key.** `pagesList` (in `derive.mjs`) keys pages by `basename(f)` (the event `entity`), while `index.json` pages carry a relative `path` and a frontmatter `id`. `pagesMeta` is therefore keyed by `basename(path)` so the detail pane can look it up from the selected list entity. Outlink resolution: `[[id]]` targets resolve against frontmatter `id`, markdown `.md` links resolve against `basename(path)`; unresolved targets are still listed (as dangling) but do not create backlinks.
- `status()` grows a `pagesMeta` map keyed by `basename(path)`, alongside existing `{ pages, raw, conflicts }`.

`pwikiBody` detail pane renders, after `page:`:
- frontmatter facts (`title`, `type`, `tags`, `source`, `compiled`, `conflict-since`);
- `summary`;
- `outlinks` and `backlinks` lists, truncated to remaining pane height;
- an `orphan` marker when applicable.

### 4. p-graph — T1 (all status fields), render-only

No adapter change: `status()` already returns the full `status --json` object (`schema_version`, `indexed_sha`, `fts`, `nodes`, `edges`, `files`, `drift`).

`pgraphBody` header is extended to surface the currently-hidden fields, e.g.:
`schema <v> · sha <indexed_sha short> · fts <on/off> · nodes N · edges N · files N · drift D`
above the existing reindex/drift history.

## Testing

TDD against existing suites:

- `adapter-pshed.test.ts` — jobs.yml parsing into `jobsMeta`, first-line prompt, model default marker, torn-read fallback.
- `adapter-ptasks.test.ts` — `readTasks` captures title/description; torn-read fallback; existing id/status diffing unaffected.
- `adapter-pwiki.test.ts` — index.json parsing, summary/outlink/backlink/orphan derivation, torn-read fallback.
- `tui-layout.test.ts` / `tui-derive.test.ts` — detail-pane lines for each tab, including truncation and empty-selection cases; p-graph header string.

Write the failing tests first, then implement each adapter + renderer change.

## Out of scope

- p-graph drift file list / per-language breakdown (would require modifying p-graph or calling extra CLI commands — deliberately deferred; T1 only).
- p-wiki lint-style health (dead links, stale, underlinked) — duplicates the `lint` skill; deferred.
- Any full-width / alternate detail layout.
