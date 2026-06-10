# Design: `source-changed` noise reduction — ignore reference/volatile sources

**Date:** 2026-06-10
**Status:** Drafted (brainstorming)
**Targets:** `plugins/p-wiki` v4.7.0 → v4.7.1 (patch — refinement of an existing lint check, backwards-compatible)
**Predecessor:** `2026-06-08-pwiki-conflict-tracking-design.md` (introduced the `source-changed` check)

---

## 1. Goal

Cut the false-positive rate of the `source-changed` lint check so it surfaces *real* derived-page staleness instead of drowning it in noise from broadly-cited or constantly-changing sources.

## 1.1 Evidence (from the `extrade/specifications` wiki)

A live audit produced **187 `source-changed` warnings across 70 pages from 23 sources**. Two sources dominate and are almost pure noise:

| pages | source | why it's noise |
|------:|--------|----------------|
| 59 | `00-glossary.md` | a shared **reference** cited in `sources:` by most concept pages; a glossary tweak doesn't invalidate the pages that merely reference it |
| 4 | `CHANGELOG.md` | **volatile** — changes on essentially every commit, so it perpetually trips the "source newer than page" test |

Spot-checking the highest-signal *real* edits (the 2026-06-09 commit) confirmed the rest are mostly coarse-trigger noise too: e.g. `03-configuration.md` changed (a narrow synthetic-ladder removal) and flagged 16 pages, of which **0** actually referenced the changed content. The genuinely-stale pages from that resync were the conflict-callout pages, already reconciled via `/p-wiki:reconcile`.

Conclusion: the check is correct but **whole-file-granular**, and the worst offenders are a recognizable class — *reference/meta files* (glossaries, changelogs, readmes) that appear in `sources:` but are not the page's *defining* source.

## 2. Design

`source-changed` skips any source whose **basename** identifies it as a reference/volatile file, and reports how many warnings it suppressed (no silent dropping).

### 2.1 Reference-source classification

A source is "reference/volatile" if its basename (directory and extension stripped, optional `NN-` / `NN_` numeric prefix ignored) matches a small built-in set:

```
changelog · glossary · readme · contributing · license
```

Matched case-insensitively, optional trailing `s`. So `CHANGELOG.md`, `00-glossary.md`, `README.md` all match; `03-configuration.md`, `05-trade-flow.md` do **not** (defining specs stay flagged — they carry real signal).

The list is deliberately conservative: only file classes that are by-nature shared references or per-commit-volatile. Defining spec sections (`trade-flow`, `price-flow`, `system-overview`, ADR decision files) are **not** suppressed — a change there may genuinely matter, so it keeps warning.

### 2.2 Transparent suppression (no silent caps)

The check still iterates every source; it just skips emitting a warning for reference sources, and accumulates what it skipped. The lint result gains:

```js
suppressed: { 'source-changed': { count: <pairs skipped>, sources: [<distinct reference paths>] } }
```

`errors` / `warnings` / `totals` keep their existing shape (so existing callers and tests are unaffected — `totals` already counts only `errors` + `warnings`). `formatLintReport` prints a note under the Source-changed section:

```
Source changed (warnings): 124
  - …
  (suppressed 63 from reference sources: CHANGELOG.md, 00-glossary.md)
```

So a user can always see *what* was filtered and challenge it if a suppressed file was actually defining.

### 2.3 Why basename denylist over the alternatives

- **Fan-out threshold** ("suppress any source cited by ≥ N pages") was rejected: in the evidence, `05-trade-flow.md` (20 pages) and `04-price-flow.md` (12) are defining specs with real signal — a fan-out cutoff would wrongly silence them while only the named glossary/changelog classes are true noise.
- **Per-page explicit "reference source" marking** (a frontmatter field) was rejected for now: it adds authoring burden and a schema change, and every existing page would need back-filling. The name-based default needs zero authoring and is correct for the standard reference file names.
- **Section/anchor-level granularity** (track which part of a source a page derived from) is the "correct" long-term fix but a large lift; out of scope.

## 3. Affected files

| Path | Change |
|---|---|
| `tools/lib/lint.mjs` | `REFERENCE_SOURCE` matcher; skip + accumulate in the `source-changed` loop; return `suppressed` |
| `tools/__tests__/lint.test.ts` | skip-CHANGELOG, skip-glossary, keep-normal-spec, suppressed-reported cases |
| `tools/pwiki.mjs` | `formatLintReport` prints the suppression note; CLI `VERSION` `3.2.0` → `3.2.1` |
| `tools/__tests__/cli-entry.test.ts` | version assertion `3.2.0` → `3.2.1` |
| `skills/lint/SKILL.md` | note that reference/volatile sources are excluded from Source-changed |
| `.claude-plugin/plugin.json` | `"version": "4.7.1"` |

## 4. Backward compatibility

Additive/refinement only: fewer warnings, no schema change, result shape extended (new optional `suppressed` field), `totals` semantics unchanged. → **patch** bump. Monorepo `v4.15.0` → `v4.15.1`.

## 5. Test strategy

- `lint.test.ts` — `source-changed` does not fire for a `CHANGELOG.md` or `00-glossary.md` source even when newer than the page; still fires for a normal spec source newer than the page; `suppressed['source-changed'].count` reflects skipped pairs and lists the distinct sources.
- Existing `source-changed` and `conflicts` tests remain green (reference matcher does not touch them).

## 6. Future work (out of scope)

- Make the reference list configurable in `.pwiki.json` if a team needs to tune it.
- Section/anchor-level source tracking for true per-change granularity.
- Optionally treat the conflict callout's *own* linked sources as defining even if named like a reference.
