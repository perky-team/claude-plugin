# pwiki `source-changed` Noise Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the `source-changed` lint check from flagging pages whose only changed source is a reference/volatile file (glossary, changelog, readme, …). Defining spec sources keep warning. Suppressed warnings are counted and surfaced — never silently dropped.

**Architecture:** A small basename matcher in `lint.mjs` classifies reference/volatile sources; the `source-changed` loop skips them and accumulates a `suppressed` summary returned alongside `errors`/`warnings`/`totals` (shapes unchanged). `formatLintReport` prints the suppression note. No schema change, no new config — patch bump.

**Tech Stack:** Node ≥ 18 stdlib, vitest + TypeScript. No new dependencies.

**Spec:** [`2026-06-10-pwiki-source-changed-noise-design.md`](../specs/2026-06-10-pwiki-source-changed-noise-design.md)

---

## File Structure

**Modified files:**

| Path | What changes |
|---|---|
| `tools/lib/lint.mjs` | `REFERENCE_SOURCE` regex; skip reference sources in the `source-changed` loop; return `suppressed['source-changed'] = { count, sources }` |
| `tools/__tests__/lint.test.ts` | skip-CHANGELOG, skip-glossary, keep-normal-spec, suppressed-reported |
| `tools/pwiki.mjs` | `formatLintReport` prints the suppression note; CLI `VERSION` `3.2.0` → `3.2.1` |
| `tools/__tests__/cli-entry.test.ts` | version assertion `3.2.0` → `3.2.1` |
| `skills/lint/SKILL.md` | note reference/volatile sources are excluded from Source-changed |
| `.claude-plugin/plugin.json` | `"version": "4.7.1"` |

---

## Layer roadmap

- **Layer 1 (Task 1):** Lint skips reference sources + reports suppression. TDD.
- **Layer 2 (Tasks 2–3):** Report note in `formatLintReport`; SKILL doc; version bumps; full suite.

Run `npm test` after each code task.

---

## Layer 1 — Lint skips reference sources

### Task 1: classify and skip reference/volatile sources

**Files:**
- Modify: `plugins/p-wiki/tools/lib/lint.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/lint.test.ts`

- [ ] **Step 1: Failing tests** (add to `lint.test.ts`)

```ts
it('does not flag source-changed for a CHANGELOG source', () => {
  const c = validConcept('a', { updated: '2026-05-12', sources: ['docs/CHANGELOG.md'] });
  const sourceDateFn = () => '2026-06-09';
  const r = runChecks([c], { repoRoot: '/x', existsFn: () => true, sourceDateFn });
  expect(r.warnings['source-changed']).toEqual([]);
  expect(r.suppressed['source-changed'].count).toBe(1);
  expect(r.suppressed['source-changed'].sources).toContain('docs/CHANGELOG.md');
});

it('does not flag source-changed for a glossary source (NN- prefix)', () => {
  const c = validConcept('a', { updated: '2026-05-12', sources: ['docs/specs/00-glossary.md'] });
  const sourceDateFn = () => '2026-06-09';
  const r = runChecks([c], { repoRoot: '/x', existsFn: () => true, sourceDateFn });
  expect(r.warnings['source-changed']).toEqual([]);
  expect(r.suppressed['source-changed'].count).toBe(1);
});

it('still flags source-changed for a normal spec source', () => {
  const c = validConcept('a', { updated: '2026-05-12', sources: ['docs/specs/03-configuration.md'] });
  const sourceDateFn = () => '2026-06-09';
  const r = runChecks([c], { repoRoot: '/x', existsFn: () => true, sourceDateFn });
  expect(r.warnings['source-changed']).toHaveLength(1);
  expect(r.suppressed['source-changed'].count).toBe(0);
});

it('reports suppressed source-changed without affecting totals', () => {
  const c = validConcept('a', { updated: '2026-05-12', sources: ['docs/CHANGELOG.md'] });
  const r = runChecks([c], { repoRoot: '/x', existsFn: () => true, sourceDateFn: () => '2026-06-09' });
  expect(r.totals.warnings).toBe(
    Object.values(r.warnings).reduce((n: number, b: any) => n + b.length, 0));
});
```

- [ ] **Step 2: Implement** in `lint.mjs`

Add near the other matchers:

```js
// Reference / volatile sources: appear in sources: but are not a page's
// *defining* source — a glossary tweak or a per-commit changelog bump should
// not flag every page that merely cites them. Matched on basename, ignoring an
// optional NN- numeric prefix and the extension.
const REFERENCE_SOURCE = /^(?:\d+[-_. ])?(?:changelog|glossary|readme|contributing|license)s?\b/i;
```

In `runChecks`, initialise the accumulator and use it in the `source-changed` loop:

```js
const suppressed = { 'source-changed': { count: 0, _sources: new Set() } };
// ...
if (sourceDateFn) {
  const pageUpdated = d.frontmatter.updated;
  for (const s of d.frontmatter.sources ?? []) {
    const base = s.split(/[\\/]/).pop() ?? s;
    if (REFERENCE_SOURCE.test(base)) {
      const sd = sourceDateFn(s);
      if (sd && pageUpdated && sd > pageUpdated) {        // only count what *would* have warned
        suppressed['source-changed'].count++;
        suppressed['source-changed']._sources.add(s);
      }
      continue;
    }
    const sourceDate = sourceDateFn(s);
    if (sourceDate && pageUpdated && sourceDate > pageUpdated) {
      warnings['source-changed'].push({ file: d.path, source: s, sourceDate, pageUpdated });
    }
  }
}
```

In the `return`, expose the summary (convert the Set to a sorted array):

```js
return {
  errors, warnings, totals,
  suppressed: { 'source-changed': {
    count: suppressed['source-changed'].count,
    sources: [...suppressed['source-changed']._sources].sort(),
  } },
};
```

(`totals` still sums only `errors` + `warnings`, so the "totals reflect counts" test stays green.)

- [ ] **Step 3: `npm test` green** for `lint.test.ts` (and unchanged `schema`/`cli-set`/`fm`).

---

## Layer 2 — Report, docs, ship

### Task 2: surface suppression in the report + SKILL

**Files:**
- Modify: `plugins/p-wiki/tools/pwiki.mjs`
- Modify: `plugins/p-wiki/skills/lint/SKILL.md`

- [ ] In `formatLintReport`, after the Source-changed section, append a note when suppressed:

```js
const sup = r.suppressed?.['source-changed'];
if (sup?.count > 0) {
  out.push(`  (suppressed ${sup.count} from reference sources: ${sup.sources.join(', ')})`);
  out.push('');
}
```

Place it so it reads under the "Source changed (warnings)" block. Guard on `r.suppressed` being absent (older callers).

- [ ] In `lint/SKILL.md`, extend the Source-changed description: reference/volatile sources (glossaries, changelogs, readmes, …) are excluded and reported as a suppression count, so the warning reflects defining-source drift only.

### Task 3: version bump + full suite

**Files:**
- Modify: `plugins/p-wiki/tools/pwiki.mjs` (CLI `VERSION`)
- Modify: `plugins/p-wiki/tools/__tests__/cli-entry.test.ts`
- Modify: `plugins/p-wiki/.claude-plugin/plugin.json`

- [ ] CLI `VERSION` `'3.2.0'` → `'3.2.1'`; update `cli-entry.test.ts` assertion.
- [ ] `plugin.json` `"version"` → `"4.7.1"`.
- [ ] `npm test` full suite green; `npm run validate` passes.
- [ ] (Optional) live check on `extrade/specifications`: `pwiki lint` Source-changed drops by ~63 (the `00-glossary.md` 59 + `CHANGELOG.md` 4), with a matching "(suppressed 63 from reference sources: …)" note.

---

## Done criteria

- `source-changed` no longer warns for glossary/changelog/readme/contributing/license sources; defining spec sources still warn.
- The suppressed count + distinct sources are reported in `pwiki lint` output (not silently dropped).
- `totals` semantics unchanged; existing tests green; `plugin.json` at `4.7.1`, CLI at `3.2.1`.
- Release: monorepo `v4.15.0` → `v4.15.1` (patch).
