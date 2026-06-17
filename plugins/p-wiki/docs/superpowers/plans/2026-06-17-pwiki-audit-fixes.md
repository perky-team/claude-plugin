# p-wiki Audit Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the correctness bugs, logical inconsistencies, and robustness gaps found in the 2026-06-17 p-wiki audit — across the FS/Confluence backends, the CLI, and the skills/docs.

**Architecture:** Independent bug fixes grouped into four phases. Phase A fixes defects introduced by the read-only-sources feature (land on the feature branch). Phases B–D fix pre-existing defects (land on a separate branch). Each task is TDD: failing test → minimal fix → green → commit.

**Tech Stack:** Node.js ESM (`.mjs`), Vitest, no new dependencies. Tests in `plugins/p-wiki/tools/__tests__/`.

## Global Constraints

- All work under `plugins/p-wiki/`. Run tests from the repo root: `npx vitest run plugins/p-wiki` (the vitest config's include globs are repo-root-relative; running from inside the plugin finds no files). For one file: `npx vitest run plugins/p-wiki/tools/__tests__/<file>`.
- Source is ESM `.mjs`; tests are Vitest `.test.ts`. No new runtime dependencies.
- CLI exit codes: 0 success, 1 user/env error, 2 schema/conflict, 3 internal. Output via `emitJson(obj, code)` / `die(msg, code)`.
- Do NOT edit `plugin.json` (version bumps are a separate release step).
- All artifact text (code, comments, docs) in English. Commit messages have NO Claude attribution.
- **Branch:** all phases (A–D) land on the current `feat/pwiki-external-readonly-sources` branch — the read-only-sources feature plus the audit fixes ship together (user decision, 2026-06-17).
- Each finding below cites the audit. "✓ verified" = confirmed against code during the audit; "agent-reported" = found by audit subagent, re-confirm the exact code/response shape in the test-writing step before fixing.

---

## File Structure

- `tools/pwiki.mjs` — `searchCommand` union trim/total (A1); `getPage` source-construction in try (A2); `index --format=text` Confluence guard (B3).
- `tools/lib/lint.mjs` — dead-link regex (B1); unknown-field warning (B2).
- `tools/lib/schema.mjs` — export used by B2.
- `tools/lib/destinations/confluence.mjs` — search pagination (B4a); applyBacklinks/movePage robustness if in scope.
- `tools/lib/confluence/search.mjs`, `confluence/lint.mjs`, `confluence/labels.mjs` — pagination (B4).
- `tools/lib/confluence/properties.mjs` — 409 retry + version-cache refresh (D1).
- `tools/lib/destinations/fs.mjs`, `tools/lib/sync.mjs` — parse-failure safety (D2); date-suffix counter (D3).
- `tools/lib/md.mjs` (new shared inline-code matcher) + `cross-links.mjs`, `backlinks.mjs`, `lint.mjs` — dedupe regex (D4); `confluence/adf.mjs` nested ordered list (D5).
- `skills/query/SKILL.md`, `skills/compile/SKILL.md`, `skills/reconcile/SKILL.md`, `skills/ingest/SKILL.md`, `skills/lint/SKILL.md` — error-table fixes (C1, C2, C3).
- `tools/__tests__/fixtures/fake-confluence.mjs` — extend for pagination test (B4).

---

# Phase A — Feature-introduced defects

## Task A1: `search` union respects `--limit` and reports an honest `total`

Finding #5 (✓ verified). `searchCommand` passes `limit` to each backend and concatenates without trimming; `total` sums incompatible counts (Confluence `totalSize` + FS `results.length`).

**Decision:** Trim the merged list to `limit` (primary first, then sources in config order — no cross-backend re-ranking, since FS BM25 scores and Confluence `score:1` are not comparable). Set `total = results.length` (the count actually returned). This keeps the no-sources FS case unchanged (FS already returns `total === results.length`) and makes the Confluence-primary case report the returned count instead of the server hit-count.

**Files:**
- Modify: `tools/pwiki.mjs` (`searchCommand`, lines 261-278)
- Test: `tools/__tests__/cli-search-sources.test.ts`

**Interfaces:**
- Produces: `searchCommand` emits `{ query, total, results, warnings }` where `results.length <= limit` and `total === results.length`.

- [ ] **Step 1: Write the failing test** — add to `cli-search-sources.test.ts`, in the FS-primary + FS-source describe block:

```ts
  it('trims the union to --limit and reports total as the returned count', () => {
    // primary has kafka.md; source has kafka-ext.md — both match "kafka".
    const r = spawnSync('node', [cli, 'search', 'kafka', '--limit=1', '--format=json'],
      { cwd: primaryDir, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.results).toHaveLength(1);
    expect(json.total).toBe(1);
    expect(json.results[0].source).toBe('fs'); // primary first
  });
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run plugins/p-wiki/tools/__tests__/cli-search-sources.test.ts`. Expected: FAIL (union returns 2 results / total 2).

- [ ] **Step 3: Implement** — in `searchCommand`, after the source loop and before `emitJson`, replace the emit with:

```js
  const limit = opts.limit;
  const trimmed = results.slice(0, limit);
  emitJson({ query, total: trimmed.length, results: trimmed, warnings }, 0);
```

(Remove the running `total` variable's use in the emit; you may keep computing it or drop it. Keep `warnings` as is.)

- [ ] **Step 4: Run to verify pass** — `npx vitest run plugins/p-wiki/tools/__tests__/cli-search-sources.test.ts plugins/p-wiki/tools/__tests__/cli-search.test.ts`. Expected: PASS (the pre-existing `--limit=1` test still asserts `results.length === 1`; `total` there equals 1).

- [ ] **Step 5: Commit** — `git add tools/pwiki.mjs tools/__tests__/cli-search-sources.test.ts && git commit -m "fix(p-wiki): trim search union to --limit and report returned count as total"`

## Task A2: ~~`getPage` constructs the source destination inside the try/catch~~ — DROPPED

**Dropped after analysis (2026-06-17).** Finding #6 is not reachable in production: `getPage` always injects `makeRealTransport()` as the transport, and `createConfluenceDestination` only throws when `(!email || !token) && !transport` — so with a real transport always present, the source factory never throws on construction. Invalid/missing credentials surface later as `auth-failed`/`network-error` through the existing `try/catch` around `readPage`. Wrapping the construction would be dead defensive code, and the only way to make a test exercise it is to alter the production transport plumbing for the test's sake. Not worth it. (Note: `searchCommand`'s own source `try/catch` from the feature is legitimate — it is exercised by a real `search()` HTTP-failure path, not a construction throw.)

The body below is retained for the record but is NOT to be implemented.

<details><summary>Original (not implemented)</summary>

Finding #6. `dest = res.sources[idx]` (line 222) is outside the `try` (starts line 226).

**Files:**
- Modify: `tools/pwiki.mjs` (`getPage`, lines 215-228)
- Test: `tools/__tests__/cli-get-sources.test.ts`

- [ ] **Step 1: Write the failing test** — add an in-process case to the Confluence-source describe block (env creds NOT set, no transport provided, so the factory throws):

```ts
  it('a source whose construction fails is reported, not a raw exit 3', async () => {
    delete process.env.PWIKI_CONFLUENCE_EMAIL;
    delete process.env.PWIKI_CONFLUENCE_TOKEN;
    let code = -1;
    const exit = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { code = c ?? 0; throw new Error(`exit:${code}`); }) as any);
    let out = '';
    const w = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as any);
    try {
      // no transport in _opts → confluence factory throws "PWIKI_CONFLUENCE_EMAIL / ... required"
      await getPage({ _: ['confluence://concept/foo'], source: 'conf', format: 'json' });
    } catch { /* exit thrown */ }
    exit.mockRestore(); w.mockRestore();
    expect(code).toBe(1);
    expect(JSON.parse(out).error.code).toBe('source-unavailable');
  });
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL (currently exits 3 via top-level mapping, or throws uncaught).

- [ ] **Step 3: Implement** — in `getPage`, move source resolution inside a guarded block:

```js
  const srcName = typeof args.source === 'string' ? args.source : undefined;
  let dest;
  if (!srcName || srcName === res.primaryName) {
    dest = res.primary;
  } else {
    const idx = res.sourceNames.indexOf(srcName);
    if (idx === -1) emitJson({ error: { code: 'unknown-source', message: `unknown source: ${srcName}` } }, 1);
    try {
      dest = res.sources[idx];
    } catch (e) {
      emitJson({ error: { code: 'source-unavailable', message: e?.message ?? String(e) } }, 1);
    }
  }
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run plugins/p-wiki/tools/__tests__/cli-get-sources.test.ts plugins/p-wiki/tools/__tests__/cli-get.test.ts plugins/p-wiki/tools/__tests__/cli-get-confluence.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — (not implemented; task dropped)

</details>

## Task A3: query skill documents the `--source` error codes

Finding #7 (✓ verified). The query skill calls `get --source` but its error table omits `unknown-source` and `bad-path`, which `getPage` emits.

**Files:**
- Modify: `skills/query/SKILL.md` (error-handling table, ~lines 94-105)

- [ ] **Step 1: Add rows** to the query skill's error table:

```markdown
| `unknown-source` | "Search result references source `<name>` not in `.pwiki.json`; the config may have changed." |
| `bad-path` | "Malformed page path for this backend." |
```

(Source auth/network failures during `get --source` already map to the existing `auth-failed` / `network-error` rows — no new row needed for those.)

- [ ] **Step 2: Verify** — Grep `skills/query/SKILL.md` for `unknown-source`, `bad-path`; both present.

- [ ] **Step 3: Commit** — `git add skills/query/SKILL.md && git commit -m "docs(p-wiki): document get --source error codes in query skill"`

---

# Phase B — Pre-existing high-impact correctness

## Task B1: Lint detects dead links that have anchors or titles

Finding #1 (✓ verified). `lint.mjs:11` `linkRe = /\[[^\]]*\]\(([^)#\s]+)\)/g` fails to match `[x](foo.md#sec)` and `[x](foo.md "t")`, so anchored/titled internal links are never existence-checked and are invisible to the orphan graph.

**Files:**
- Modify: `tools/lib/lint.mjs:11`
- Test: `tools/__tests__/lint.test.ts`

- [ ] **Step 1: Write the failing test** — add to `lint.test.ts` a page whose only link is anchored and points at a non-existent target; assert it appears in `errors['dead-links']`. Use the existing test's fixture-building style (read the file first to match how pages/wikis are constructed). Concretely, a concept page body containing `[Pods](pages/concept/ghost.md#overview)` where `ghost.md` does not exist must yield a dead-link finding for `pages/concept/ghost.md`.

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL (no dead-link reported; link not matched).

- [ ] **Step 3: Implement** — replace line 11:

```js
const linkRe = /\[[^\]]*\]\(\s*([^)#\s]+)(?:#[^)\s]*)?(?:\s+"[^"]*")?\s*\)/g;
```

The capture group is the path before any `#anchor` or `"title"`. Confirm the existing dead-link/orphan logic uses `m[1]` as the path (it does) — anchors/titles are now stripped from the captured path.

- [ ] **Step 4: Run to verify pass** — `npx vitest run plugins/p-wiki/tools/__tests__/lint.test.ts`. Expected: PASS, including pre-existing link tests.

- [ ] **Step 5: Commit** — `git add tools/lib/lint.mjs tools/__tests__/lint.test.ts && git commit -m "fix(p-wiki): lint dead-link check handles anchored and titled links"`

## Task B2: Lint warns on unknown frontmatter fields

Finding #2 (✓ verified). `validateFrontmatter` (`schema.mjs:34`) checks only `required`; the `allowed` list is unused, so typo'd keys (`tag:`, `update:`) pass silently.

**Decision:** Surface unknown fields as a lint **warning** (not a hard validation error), so write paths (`new`/`set`) are unaffected. Add a new lint warning bucket `unknown-fields`.

**Files:**
- Modify: `tools/lib/lint.mjs` (frontmatter check + warnings assembly), using `allowedFields` from `schema.mjs` (already exported, `schema.mjs:30`)
- Test: `tools/__tests__/lint.test.ts`

- [ ] **Step 1: Write the failing test** — a page with a misspelled field (e.g. `tag: [x]` instead of `tags:`, plus the real required `tags:` present so `required` still passes) must produce a `warnings['unknown-fields']` entry naming the file and the offending key `tag`. Match the existing lint-report shape (read `lint.mjs` to see how warning buckets are keyed and how `formatLintReport` in `pwiki.mjs:76` renders them — add a render line there too).

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL (no such warning bucket).

- [ ] **Step 3: Implement** —
  (a) In `lint.mjs`, import `allowedFields`. For each page with a known type, compute `Object.keys(fm).filter(k => !allowedFields(fm.type).includes(k))`; push `{ file, fields }` into a new `warnings['unknown-fields']` array. Skip raw types if their schema is exact (RAW_FIELDS is both required and allowed, so unknown raw keys are caught too — include them).
  (b) In `pwiki.mjs` `formatLintReport`, add a section line for `unknown-fields` mirroring the others, and include its count in `totals.warnings`.

- [ ] **Step 4: Run to verify pass** — `npx vitest run plugins/p-wiki/tools/__tests__/lint.test.ts plugins/p-wiki/tools/__tests__/cli-lint.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add tools/lib/lint.mjs tools/pwiki.mjs tools/__tests__/lint.test.ts && git commit -m "fix(p-wiki): lint warns on unknown frontmatter fields"`

## Task B3: `index --format=text` errors cleanly on a Confluence primary

Finding #3 (✓ verified). `pwiki.mjs:517` `readFileSync(\`${dest.rootPath}/${pagePath}\`)` throws ENOENT → exit 3 when the primary is Confluence (synthetic `rootPath`, `confluence://` paths). The JSON path works.

**Decision:** The text renderer is fundamentally FS-only (it reads page bodies off disk for summaries). Guard it: if the primary isn't FS, `die` with a clear message pointing to `--format=json`.

**Files:**
- Modify: `tools/pwiki.mjs` (`index` handler, the `if (format === 'text')` block, ~line 509)
- Test: `tools/__tests__/cli-index.test.ts` (or a new confluence-targeted test using the fake transport pattern)

- [ ] **Step 1: Write the failing test** — with a Confluence-primary `.pwiki.json` (mirror the `cli-get-confluence.test.ts` setup), run `index --format=text` and assert exit 1 with a message mentioning `--format=json` (NOT exit 3). Since `index` isn't exported, drive it via subprocess (`spawnSync`) — but a subprocess can't inject a fake transport. Instead assert that with a Confluence primary the command exits 1 (not 3) **before** any HTTP call: the guard runs on `dest.kind`, which is known without I/O.

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL (currently reaches `listPages`/HTTP and/or exits 3).

- [ ] **Step 3: Implement** — at the top of the `if (format === 'text')` block:

```js
    if (dest.kind !== 'fs') die('index --format=text is only supported for filesystem wikis; use --format=json', 1);
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run plugins/p-wiki/tools/__tests__/cli-index.test.ts`. Expected: PASS (FS text rendering unchanged).

- [ ] **Step 5: Commit** — `git add tools/pwiki.mjs tools/__tests__/cli-index.test.ts && git commit -m "fix(p-wiki): guard index --format=text against non-fs primaries"`

## Task B4: Paginate Confluence search, lint, and label reads

Finding #4 (✓ verified for search/lint; labels agent-reported). `confluence.mjs` `search` (line 365), `confluence/lint.mjs` (~line 11), and `confluence/labels.mjs` (~line 2) each read a single page (`limit`/250/200) and ignore pagination, so large/ type-filtered queries silently under-return — `lint` then emits false orphan/dead-link findings. `children.mjs` already paginates correctly (follow `_links.next`) — reuse that pattern.

**Files:**
- Modify: `tools/lib/destinations/confluence.mjs` (`search`), `tools/lib/confluence/lint.mjs`, `tools/lib/confluence/labels.mjs`
- Modify (test infra): `tools/__tests__/fixtures/fake-confluence.mjs` — the v1 search handler currently returns all matches with no paging; add `start`/`limit` slicing + a `_links.next` (or `start`-based) cursor so pagination can be exercised.
- Test: `tools/__tests__/confluence-search.test.ts`, `tools/__tests__/destination-confluence-search.test.ts`

- [ ] **Step 1: Write the failing test** — first extend `fake-confluence.mjs` v1-search handler to honor `&start=N&limit=M` and return a `_links.next` when more results remain (read its current handler at fixtures lines ~177-187). Then a test: seed >limit pages, all matching the query, all of one type, request that type with `limit` smaller than the match count, and assert `search` returns `limit` matches of that type (i.e. it paged past non-matching/early hits). Assert exit/results from the destination's `search` directly (not via CLI).

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL (single-page read under-returns).

- [ ] **Step 3: Implement** — in `confluence.mjs` `search`, loop following `_links.next` (or incrementing `start`) accumulating mapped+type-filtered results until `limit` matches collected or results exhausted; cap iterations (mirror `children.mjs`'s 1000-iteration guard). Apply the same paginated read in `confluence/lint.mjs`'s page enumeration and `confluence/labels.mjs`'s label GET. Keep `total` semantics documented (post-filter count).

- [ ] **Step 4: Run to verify pass** — `npx vitest run plugins/p-wiki/tools/__tests__/confluence-search.test.ts plugins/p-wiki/tools/__tests__/destination-confluence-search.test.ts plugins/p-wiki/tools/__tests__/confluence-lint.test.ts plugins/p-wiki/tools/__tests__/confluence-labels.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add tools/lib/destinations/confluence.mjs tools/lib/confluence/lint.mjs tools/lib/confluence/labels.mjs tools/__tests__/fixtures/fake-confluence.mjs && git commit -m "fix(p-wiki): paginate Confluence search, lint, and label reads"`

---

# Phase C — Skills/docs consistency

## Task C1: Remove/relabel phantom error codes in skill tables

Finding #8 (✓ verified). `slug-taken`, `target-exists`, `schema-violation` appear in compile/query/ingest/lint/reconcile error tables but `mapErrorToCode` never returns them and no command emits them in `error.code`. The real slug conflict surfaces as `new`/`promote` exit 2 with `existing-path`/`date-suffix-slug` payloads (no `error.code`).

**Files:**
- Modify: `skills/compile/SKILL.md`, `skills/query/SKILL.md`, `skills/ingest/SKILL.md`, `skills/lint/SKILL.md`, `skills/reconcile/SKILL.md`

- [ ] **Step 1: Confirm absence** — Grep `tools/pwiki.mjs` and `tools/lib/**` for `slug-taken`, `target-exists`, `schema-violation`. Confirm none are emitted as `error.code` (they appear only in the exit-code arithmetic at `pwiki.mjs:578`). If any IS emitted somewhere, keep that row and skip it below.

- [ ] **Step 2: Edit tables** — in each skill, replace the three phantom rows with an accurate description of the exit-2 conflict payload, e.g.:

```markdown
| exit 2 with `existing-path` / `date-suffix-slug` (no `error.code`) | A page with that slug exists. Offer to reuse `existing-path` or write to the suggested `date-suffix-slug`. |
```

(Only `new`/`promote` produce this; keep it in the skills that call them — compile, query, ingest, reconcile. The lint skill, which never writes, should simply drop the phantom rows.)

- [ ] **Step 3: Verify** — Grep the five skills: no remaining `slug-taken`/`target-exists`/`schema-violation` rows (unless Step 1 found a real emitter).

- [ ] **Step 4: Commit** — `git add skills/*/SKILL.md && git commit -m "docs(p-wiki): correct phantom error codes in skill error tables"`

## Task C2: Fix the `backlinks` exit-code claims in compile/reconcile

Finding #9 (✓ verified). `backlinks` wraps in `try/catch → die(e.message, 1)` (`pwiki.mjs:489-495`): exit 1, plain stderr, no JSON. compile 4f / reconcile claim it can exit 3 and return JSON `error.code`.

**Files:**
- Modify: `skills/compile/SKILL.md` (step 4f, ~line 124), `skills/reconcile/SKILL.md` (~line 105)

- [ ] **Step 1: Edit** — replace the backlinks exit-code handling so it states: exit 0 = applied; exit 2 = `suspicious` (JSON with `candidates`, over the threshold — surface for human review); exit 1 = failure (plain stderr line `pwiki: <msg>`, NOT JSON) → report the target and continue. Remove the exit-3/`error.code` claim for backlinks. Leave the `index` exit-3 note (it can reach the top-level catch).

- [ ] **Step 2: Verify** — Grep both skills' backlinks sections: no "exit 3" / "error.code" for backlinks.

- [ ] **Step 3: Commit** — `git add skills/compile/SKILL.md skills/reconcile/SKILL.md && git commit -m "docs(p-wiki): correct backlinks exit-code handling in compile and reconcile"`

## Task C3: Minor skill cleanups

Skills agent findings #4–#7 (low severity). Optional polish; bundle into one commit.

**Files:** `skills/query/SKILL.md`, `skills/init/SKILL.md`

- [ ] **Step 1: Edit** —
  (a) query: renumber steps (Step 4 is missing — 3 then 5); replace the "Empty grep results" edge-case wording with "Empty search results"; note `search` never returns a JSON `error.code` (failures surface only via the `warnings[]` array).
  (b) init: drop `Bash(test:*)` from `allowed-tools` if `test` is genuinely unused (Grep the init steps first to confirm).

- [ ] **Step 2: Verify** — re-read the edited sections; confirm step numbers are contiguous and `allowed-tools` matches actual usage.

- [ ] **Step 3: Commit** — `git add skills/query/SKILL.md skills/init/SKILL.md && git commit -m "docs(p-wiki): minor query/init skill cleanups"`

---

# Phase D — Robustness (lower confidence — verify each in Step 1)

## Task D1: Confluence property upsert retries on 409 and refreshes its version cache

Findings #1–#3 of the Confluence audit (agent-reported, Medium confidence). `properties.upsert` has no 409 retry (unlike body-PUT), and `readAll` discards version numbers so the cached versions can go stale → a single 409 aborts `writePage`/`mutatePage`.

**Files:**
- Modify: `tools/lib/confluence/properties.mjs`
- Test: `tools/__tests__/confluence-properties.test.ts`

- [ ] **Step 1: Confirm the gap** — read `properties.mjs` fully; confirm (a) `upsert` PUTs `version: existing.version + 1` with no retry, and (b) `readAll` does a value GET whose response carries version numbers that are NOT written back to the cached version map. If either is false, adjust scope.

- [ ] **Step 2: Write failing tests** — using `fake-confluence`: (a) make a property PUT return 409 once then succeed; assert `upsert` retries and succeeds. (b) After `readAll`, mutate the property's server version out-of-band, then `upsert`; assert it re-reads and succeeds rather than 409-failing. (The fake's property PUT handler currently returns 200/404 — extend it to model a one-shot 409 like the page-body path.)

- [ ] **Step 3: Implement** — on `upsert` 409, re-fetch the property's current version and retry once (mirror the single-retry in `confluence.mjs` body PUTs). Have `readAll` (or its inner GET) update the cached `{id, version}` map from the same response it already fetches.

- [ ] **Step 4: Run to verify pass** — `npx vitest run plugins/p-wiki/tools/__tests__/confluence-properties.test.ts plugins/p-wiki/tools/__tests__/destination-confluence-write.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add tools/lib/confluence/properties.mjs tools/__tests__/* && git commit -m "fix(p-wiki): retry Confluence property upsert on 409 and refresh version cache"`

## Task D2: Sync does not delete a mirror page because of an unparseable source page

Finding #4 of the FS audit (agent-reported, Medium-High). `fs.mjs` listing helpers swallow parse errors with bare `catch {}`, dropping a malformed-frontmatter page from `srcIndex`; sync's true-mirror delete pass then removes that page from the mirror — data loss driven by a primary-side typo.

**Files:**
- Modify: `tools/lib/destinations/fs.mjs` (listing/walk), `tools/lib/sync.mjs` (delete pass)
- Test: `tools/__tests__/sync-unit.test.ts` (or `destination-fs-*`)

- [ ] **Step 1: Confirm** — read `fs.mjs` `walkDir`/`listPages`/`search`/`lint` and `sync.mjs` passes; confirm parse failures are silently skipped and the delete pass keys off the (now-incomplete) source set.

- [ ] **Step 2: Write failing test** — a primary with one valid page and one malformed-frontmatter page, a mirror that already contains both; run sync; assert the malformed page's mirror copy is NOT deleted and that sync reports the parse failure (e.g. throws / returns an error entry) rather than silently mirroring a deletion.

- [ ] **Step 3: Implement** — make the FS listing used by sync surface parse failures (return them in a side channel or count) instead of silently dropping; in `sync.mjs`, if the source enumeration had any parse failure, skip the delete pass (or abort with a clear error) so an unreadable source page can never cause a mirror deletion. Also have `lint` report unparseable files as a `frontmatter` error (today they vanish).

- [ ] **Step 4: Run to verify pass** — `npx vitest run plugins/p-wiki/tools/__tests__/sync-unit.test.ts plugins/p-wiki/tools/__tests__/cli-sync.test.ts plugins/p-wiki/tools/__tests__/lint.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add tools/lib/destinations/fs.mjs tools/lib/sync.mjs tools/lib/lint.mjs tools/__tests__/* && git commit -m "fix(p-wiki): never delete a mirror page due to an unparseable source page"`

## Task D3: Date-suffix slug collision appends a counter instead of overwriting

Finding #9 of the FS audit (✓ verified). `fs.mjs:43-47`: with `onConflict: 'date-suffix'`, if `slug-YYYY-MM-DD.md` already exists, the code falls through and overwrites — data loss for the second same-day creation.

**Files:**
- Modify: `tools/lib/destinations/fs.mjs` (lines 43-47)
- Test: `tools/__tests__/destination-fs-write.test.ts`

- [ ] **Step 1: Write failing test** — create a page with `onConflict: 'date-suffix'` when both `slug.md` and `slug-<today>.md` already exist; assert the result is a new file `slug-<today>-2.md` (counter), not an overwrite of `slug-<today>.md`.

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL (overwrites).

- [ ] **Step 3: Implement** — after computing the date-suffixed slug, if it also exists, append `-2`, `-3`, … until a free name is found (cap the loop, e.g. 100).

- [ ] **Step 4: Run to verify pass** — `npx vitest run plugins/p-wiki/tools/__tests__/destination-fs-write.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add tools/lib/destinations/fs.mjs tools/__tests__/destination-fs-write.test.ts && git commit -m "fix(p-wiki): counter-suffix on date-suffix slug collision instead of overwrite"`

## Task D4: Shared inline-code matcher (double-backtick spans)

Finding #5 of the FS audit (✓ verified by inspection). The `` /`[^`\n]+`/g `` matcher is duplicated in `cross-links.mjs`, `backlinks.mjs`, `lint.mjs`, `md.mjs` and breaks on double-backtick spans (`` ``a ` b`` ``), so links/tags inside such spans can be wrongly rewritten/flagged.

**Files:**
- Modify: `tools/lib/md.mjs` (add an exported `inlineCodeRanges`/matcher), and replace the four duplicate regexes with calls to it.
- Test: `tools/__tests__/md.test.ts` (+ the affected callers' tests stay green)

- [ ] **Step 1: Write failing test** — in `md.test.ts`, a string with a double-backtick span containing an interior single backtick and a `[link](x.md)` inside the span; assert the matcher treats the whole span as code (the link is inside a code range).

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Implement** — add a variable-length-fence matcher (e.g. `` /(`+)(?:(?!\1).)*?\1/gs `` or an equivalent tokenizer) in `md.mjs`, exported. Replace the four duplicated single-backtick regexes (cross-links, backlinks, lint code-range finder, md) with this shared helper. Keep the triple-backtick block handling as is.

- [ ] **Step 4: Run to verify pass** — `npx vitest run plugins/p-wiki/tools/__tests__/md.test.ts plugins/p-wiki/tools/__tests__/cross-links.test.ts plugins/p-wiki/tools/__tests__/backlinks.test.ts plugins/p-wiki/tools/__tests__/lint.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add tools/lib/md.mjs tools/lib/cross-links.mjs tools/lib/backlinks.mjs tools/lib/lint.mjs tools/__tests__/md.test.ts && git commit -m "fix(p-wiki): share an inline-code matcher that handles double-backtick spans"`

## Task D5: ADF conversion handles nested ordered lists

Finding #12 of the Confluence audit (✓ verified by inspection). `confluence/adf.mjs:73` nested-list lookahead is `/^\s*[-*] /` (bullets only), so a nested ordered sublist under a list item is mis-parsed; the markdown↔ADF round-trip is lossy for mixed nested lists.

**Files:**
- Modify: `tools/lib/confluence/adf.mjs` (~line 73)
- Test: `tools/__tests__/confluence-adf.test.ts`

- [ ] **Step 1: Write failing test** — `markdownToAdf` on a bullet item with a nested ordered sublist (`- a\n  1. b\n  2. c`) produces an ADF where the ordered sublist nests inside the bullet item; and the round-trip back via `adfToMarkdown` preserves the nesting.

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Implement** — broaden the nested-list lookahead to accept both bullets and ordered markers: `/^\s*(?:[-*]|\d+\.)\s/`. Verify the surrounding list-building logic handles the ordered branch (it may need an `orderedList` node type for the nested case).

- [ ] **Step 4: Run to verify pass** — `npx vitest run plugins/p-wiki/tools/__tests__/confluence-adf.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add tools/lib/confluence/adf.mjs tools/__tests__/confluence-adf.test.ts && git commit -m "fix(p-wiki): ADF conversion handles nested ordered lists"`

---

## Final verification

- [ ] Full suite green: `npx vitest run plugins/p-wiki`. Expected: all pass (5 live-credential e2e remain skipped).
- [ ] No `plugin.json` edits in any commit.

## Out of scope / not fixed (by design or low value)

- "Primary search failure is fatal" — intentional (the user's own wiki must work); not a bug.
- `getPage` json/text branch relies on `emitJson` exiting — latent only, currently correct; leave as is unless `emitJson` is ever made non-exiting.
- `--`-prefixed flag values swallowed by `parseArgs` (CLI audit #4) — document the `--flag=value` workaround rather than rework the parser, unless a real command needs it.
- `fs path` escaping the repo root (CLI audit #9) — local trusted config; no containment guard added.

## Self-review notes (coverage)

Every audit finding maps to a task: lint dead-link regex → B1; `allowed` unused → B2; index text on Confluence → B3; Confluence pagination (search/lint/labels) → B4; search union limit/total → A1; getPage construction → A2; skill `--source` codes → A3; phantom error codes → C1; backlinks exit codes → C2; minor skill nits → C3; property 409/version → D1; sync silent-delete → D2; date-suffix overwrite → D3; double-backtick regex → D4; ADF nested ordered list → D5. Items consciously not fixed are listed above with rationale.
