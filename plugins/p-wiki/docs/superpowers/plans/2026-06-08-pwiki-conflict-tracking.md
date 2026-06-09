# pwiki Conflict Tracking & Source-Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make unresolved factual conflicts and source-divergence visible and tracked, instead of free-text callouts no tool surfaces. Add a machine-readable `conflict-since` frontmatter field, stop `compile` from masking `updated` when it merely flags a conflict, and add two new `lint` checks (`conflicts`, `source-changed`).

**Architecture:** One optional frontmatter field `conflict-since` is the single source of truth (the body callout stays human-facing prose). `lint`'s pure `runChecks` gains two warning buckets and an injected `sourceDateFn` dependency (mirroring the existing `existsFn`); the FS destination backs `sourceDateFn` with `git log -1 --format=%cs`. `compile`'s conflict path switches from `set --bump-updated` to `set --conflict-since`; reconciliation uses a new `set --clear-conflict`. All additive — no migration, minor bump.

**Tech Stack:** Node ≥ 18 stdlib (`node:fs`, `node:child_process` for `git`), vitest + TypeScript for tests. No new npm dependencies.

**Spec:** [`2026-06-08-pwiki-conflict-tracking-design.md`](../specs/2026-06-08-pwiki-conflict-tracking-design.md)

---

## File Structure

**Existing files (modified during this plan):**

| Path | What changes |
|---|---|
| `tools/lib/schema.mjs` | Add `conflict-since` to allowed sets for `concept`/`person`/`source`/`query`; validate date format if present |
| `tools/lib/lint.mjs` | Add `conflicts` + `source-changed` warning buckets; accept optional `sourceDateFn` |
| `tools/lib/destinations/fs.mjs` | `lint()` injects a git-backed `sourceDateFn` |
| `tools/pwiki.mjs` | `set` subcommand gains `--conflict-since` / `--clear-conflict`; bump CLI `VERSION` `'3.0.0'` → `'3.1.0'` (this is the CLI's own semver, **not** the plugin version) |
| `tools/__tests__/schema.test.ts` | `conflict-since` accept/reject cases |
| `tools/__tests__/lint.test.ts` | `conflicts` + `source-changed` bucket tests |
| `tools/__tests__/cli-set.test.ts` | `--conflict-since` / `--clear-conflict` behaviour |
| `tools/__tests__/destination-fs-lint.test.ts` | git-backed `sourceDateFn` integration via temp git repo |
| `skills/compile/SKILL.md` | §4.4/step 4d standardized callout + `--conflict-since` (no `--bump-updated`); reconciliation path uses `--clear-conflict` |
| `skills/lint/SKILL.md` | Document the two new checks in the report output |
| `skills/_shared/templates/wiki-claude-md.template.md` | Document `conflict-since` field + callout convention |
| `docs/superpowers/specs/2026-05-11-p-wiki-plugin-design.md` | §3.5 + §4.4 reference conflict tracking |
| `.claude-plugin/plugin.json` | `"version": "4.6.0"` |

---

## Layer roadmap

Each layer ships green tests before the next starts. Run `npm test` after every task.

- **Layer 1 (Tasks 1–2):** Schema — `conflict-since` field, accepted and validated. Pure, no dependencies.
- **Layer 2 (Tasks 3–5):** Lint — `conflicts` check (pure), then `source-changed` check (injected `sourceDateFn`), then the git-backed real impl in `fs.mjs`.
- **Layer 3 (Tasks 6–7):** CLI — `set --conflict-since` and `set --clear-conflict`.
- **Layer 4 (Tasks 8–10):** Skills & docs — `compile` conflict path, `lint` report, CLAUDE.md template, design-spec cross-refs, version bump.

---

## Layer 1 — Schema

### Task 1: Accept and validate `conflict-since`

**Files:**
- Modify: `plugins/p-wiki/tools/lib/schema.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/schema.test.ts`

> **Note (verified in code):** `allowedFields` is an unused export and `validateFrontmatter` does **not** reject unknown fields — so a page with `conflict-since` already validates. The functional change in this task is the **date-format rejection**; the allowed-list edit keeps the schema table honest and is asserted via `allowedFields(...)`.

- [ ] **Step 1: Write the failing tests**

Add to `schema.test.ts`:

```ts
it('lists conflict-since as an allowed field on a concept', () => {
  expect(allowedFields('concept')).toContain('conflict-since');   // fails until the table is edited
});

it('rejects a malformed conflict-since', () => {
  const fm = { id: 'x', type: 'concept', title: 'X', created: '2026-01-01',
    updated: '2026-01-01', status: 'active', tags: [], sources: [],
    'conflict-since': 'June 5' };
  expect(validateFrontmatter(fm).ok).toBe(false);
});

it('still validates a page with no conflict-since', () => {
  const fm = { id: 'x', type: 'concept', title: 'X', created: '2026-01-01',
    updated: '2026-01-01', status: 'active', tags: [], sources: [] };
  expect(validateFrontmatter(fm).ok).toBe(true);
});
```

- [ ] **Step 2: Implement**

In `schema.mjs`, add the field to the allowed sets only (not required):

```js
const BASE_ALLOWED = [...BASE_PAGE, 'conflict-since'];

const TYPE_SCHEMAS = {
  concept: { required: BASE_PAGE, allowed: BASE_ALLOWED },
  person:  { required: BASE_PAGE, allowed: BASE_ALLOWED },
  source: {
    required: [...BASE_PAGE, 'source-url', 'source-type'],
    allowed: [...BASE_ALLOWED, 'source-url', 'source-type'],
  },
  query: { required: QUERY_FIELDS, allowed: [...QUERY_FIELDS, 'updated', 'conflict-since'] },
  // raw-* unchanged
};
```

In `validateFrontmatter`, after the existing checks:

```js
if ('conflict-since' in fm && !/^\d{4}-\d{2}-\d{2}$/.test(String(fm['conflict-since']))) {
  return { ok: false, error: `conflict-since must be YYYY-MM-DD: ${fm['conflict-since']}` };
}
```

- [ ] **Step 3: `npm test` green.**

---

## Layer 2 — Lint

### Task 2: `conflicts` warning bucket (pure)

**Files:**
- Modify: `plugins/p-wiki/tools/lib/lint.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/lint.test.ts`

- [ ] **Step 1: Failing test**

```ts
it('flags a page with conflict-since', () => {
  const docs = [{ path: 'docs/wiki/pages/concept/a.md',
    frontmatter: { type: 'concept', status: 'active', updated: '2026-06-05',
      sources: [], 'conflict-since': '2026-06-05' }, body: '# A\n[x](b.md)' }];
  const r = runChecks(docs, { repoRoot: '/r', existsFn: () => true });
  expect(r.warnings.conflicts).toHaveLength(1);
  expect(r.warnings.conflicts[0]).toMatchObject({ file: docs[0].path, since: '2026-06-05' });
});

it('does not flag a page without conflict-since', () => {
  const docs = [{ path: 'docs/wiki/pages/concept/a.md',
    frontmatter: { type: 'concept', status: 'active', updated: '2026-06-05', sources: [] },
    body: '# A' }];
  const r = runChecks(docs, { repoRoot: '/r', existsFn: () => true });
  expect(r.warnings.conflicts ?? []).toHaveLength(0);
});
```

- [ ] **Step 2: Implement**

Add `conflicts: []` (and `'source-changed': []`, used in Task 3) to the `warnings` object. Inside the per-doc loop:

```js
if (d.frontmatter['conflict-since']) {
  warnings.conflicts.push({
    file: d.path,
    since: d.frontmatter['conflict-since'],
    days: daysBetween(d.frontmatter['conflict-since'], todayStr),
  });
}
```

- [ ] **Step 3: `npm test` green.**

### Task 3: `source-changed` check (injected dependency)

**Files:**
- Modify: `plugins/p-wiki/tools/lib/lint.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/lint.test.ts`

- [ ] **Step 1: Failing test**

```ts
it('flags a page whose source is newer than its updated date', () => {
  const docs = [{ path: 'docs/wiki/pages/concept/a.md',
    frontmatter: { type: 'concept', status: 'active', updated: '2026-05-12',
      sources: ['docs/specs/s.md'] }, body: '# A' }];
  const sourceDateFn = (p) => (p === 'docs/specs/s.md' ? '2026-06-05' : null);
  const r = runChecks(docs, { repoRoot: '/r', existsFn: () => true, sourceDateFn });
  expect(r.warnings['source-changed']).toHaveLength(1);
  expect(r.warnings['source-changed'][0]).toMatchObject({
    file: docs[0].path, source: 'docs/specs/s.md', sourceDate: '2026-06-05', pageUpdated: '2026-05-12' });
});

it('skips source-changed when sourceDateFn is absent', () => {
  const docs = [{ path: 'docs/wiki/pages/concept/a.md',
    frontmatter: { type: 'concept', status: 'active', updated: '2026-05-12',
      sources: ['docs/specs/s.md'] }, body: '# A' }];
  const r = runChecks(docs, { repoRoot: '/r', existsFn: () => true });
  expect(r.warnings['source-changed'] ?? []).toHaveLength(0);
});
```

- [ ] **Step 2: Implement**

Extend the signature: `runChecks(docs, { repoRoot, existsFn, sourceDateFn })`. Inside the per-doc loop, guarded on `sourceDateFn`:

```js
if (sourceDateFn) {
  for (const s of d.frontmatter.sources ?? []) {
    const sd = sourceDateFn(s);
    const pu = d.frontmatter.updated;
    if (sd && pu && sd > pu) {
      warnings['source-changed'].push({ file: d.path, source: s, sourceDate: sd, pageUpdated: pu });
    }
  }
}
```

(`sd > pu` is a lexical compare on `YYYY-MM-DD` — correct for ISO dates.)

- [ ] **Step 3: `npm test` green.**

### Task 4: git-backed `sourceDateFn` in `fs.mjs`

**Files:**
- Modify: `plugins/p-wiki/tools/lib/destinations/fs.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/destination-fs-lint.test.ts`

- [ ] **Step 1: Failing integration test**

In a temp dir, `git init`, commit a source file, write a page whose `updated` predates the commit, then assert `dest.lint().warnings['source-changed']` is non-empty. Commit a second time to bump the source's commit date if needed for determinism. Use `execFileSync('git', …)` in the test setup.

- [ ] **Step 2: Implement**

In `fs.mjs`, add a helper and pass it into `runChecks`:

```js
import { execFileSync } from 'node:child_process';

function sourceDate(relPath) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', relPath],
      { cwd: rootPath, encoding: 'utf-8' }).trim();
    return out || null;            // 'YYYY-MM-DD' (committer date, short)
  } catch { return null; }         // untracked / not a git repo → skip
}
```

In the existing `lint()`:

```js
return runChecks(docs, { repoRoot: rootPath, existsFn: existsSync, sourceDateFn: sourceDate });
```

- [ ] **Step 3: `npm test` green.**

---

## Layer 3 — CLI `set`

### Task 5: `set --conflict-since <date>`

**Files:**
- Modify: `plugins/p-wiki/tools/pwiki.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/cli-set.test.ts`

- [ ] **Step 1: Failing test** — `set <page> --conflict-since 2026-06-05` writes the field and leaves `updated` unchanged.

```ts
it('--conflict-since sets the field without bumping updated', () => {
  // create a concept page with updated: <old>, run set --conflict-since,
  // assert frontmatter['conflict-since'] === '2026-06-05' && updated === <old>
});
```

- [ ] **Step 2: Implement** — in the `set` command branch (`pwiki.mjs:294`), when `args['conflict-since']` is present, first reject a malformed date (schema regex, `die(..., 1)`), then add to the existing mutations object **without** `bumpUpdated`:

```js
if (args['conflict-since']) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args['conflict-since']))) die('--conflict-since expects YYYY-MM-DD', 1);
  mutations.setFields = { ...(mutations.setFields ?? {}), 'conflict-since': args['conflict-since'] };
}
```

Relies on `mutatePage` bumping `updated` only when `bumpUpdated` is passed (confirmed: `promote` passes it explicitly; `set` does not bump otherwise).

- [ ] **Step 3: `npm test` green.**

### Task 6: `set --clear-conflict`

**Files:**
- Modify: `plugins/p-wiki/tools/pwiki.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/cli-set.test.ts`

- [ ] **Step 1: Failing test** — `set <page> --clear-conflict` removes `conflict-since` and bumps `updated` to today.

- [ ] **Step 2: Implement** — when `args['clear-conflict']`, use `mutatePage`'s `removeFields` + `bumpUpdated` (both already supported, per `promote`):

```js
if (args['clear-conflict']) {
  mutations.removeFields = [...(mutations.removeFields ?? []), 'conflict-since'];
  mutations.bumpUpdated = true;
}
```

Removing an absent field is already a no-op — `fs.mjs` `mutatePage` guards `removeFields` with `if (k in newFm)` (fs.mjs:120), so `--clear-conflict` on a non-conflicted page is safe. May be combined with other `set` flags.

- [ ] **Step 3: `npm test` green.**

---

## Layer 4 — Skills, docs, ship

### Task 7: `compile` conflict path

**Files:**
- Modify: `plugins/p-wiki/skills/compile/SKILL.md`

- [ ] Update step 4d (conflict callouts). The conflict target is usually a *different* page than the one being compiled (e.g. compiling ADR-0032 flags `pricing-engine`). When inserting a callout into a target page:
  - Use the standardized leading marker: `> ⚠️ Conflict (since <date>): … Body below reflects the pre-conflict sources.`
  - Run `set <target-page> --conflict-since <today>` to record the flag.
  - **Do not move the target's `updated`** — neither via `set --bump-updated` nor by editing the frontmatter date by hand. The body was not reconciled, so `updated` must keep reflecting the last reconciled edit (this is what makes the `stale` and `source-changed` checks meaningful).
- [ ] Add a reconciliation note: when a later `compile` pass *does* rewrite the body to agree with the new source, remove the callout and run `set <target-page> --clear-conflict` (which bumps `updated`).

### Task 8: `lint` report

**Files:**
- Modify: `plugins/p-wiki/skills/lint/SKILL.md`

- [ ] Document the two new buckets in the report: `conflicts` (open conflicts, with age) and `source-changed` (a `sources:` entry committed after the page's `updated`). Both are warnings. State the suggested fix: re-run `/p-wiki:compile <source>` to reconcile, then the flag clears.

### Task 9: CLAUDE.md template

**Files:**
- Modify: `plugins/p-wiki/skills/_shared/templates/wiki-claude-md.template.md`

- [ ] Document the optional `conflict-since` frontmatter field and the standardized callout convention so the auto-loaded wiki CLAUDE.md teaches both to any agent editing the wiki.

### Task 10: Cross-refs, version, full suite

**Files:**
- Modify: `plugins/p-wiki/docs/superpowers/specs/2026-05-11-p-wiki-plugin-design.md`
- Modify: `plugins/p-wiki/.claude-plugin/plugin.json`
- Modify: `plugins/p-wiki/tools/pwiki.mjs`

- [ ] In the original design spec, update §3.5 (lint checks list) and §4.4 (compile conflict rule) to reference `conflict-since` and the two new checks; link this design doc.
- [ ] Bump `plugin.json` `"version"` to `"4.6.0"` (plugin version) and CLI `VERSION` in `pwiki.mjs` from `'3.0.0'` to `'3.1.0'` (the CLI's own independent semver — additive flags + lint checks).
- [ ] Run the full `npm test` suite; both FS and Confluence suites stay green.

---

## Done criteria

- A page with `conflict-since` is reported by `pwiki lint` under `conflicts`.
- A page whose `sources:` entry was committed after its `updated` is reported under `source-changed`.
- `compile` flagging a conflict no longer moves `updated`; `set --clear-conflict` is the only path that clears the flag and bumps `updated`.
- All existing tests still pass; no migration required; `plugin.json` at `4.6.0`.
