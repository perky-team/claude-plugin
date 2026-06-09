# Design: `pwiki` conflict tracking & source-freshness

**Date:** 2026-06-08
**Status:** Drafted (brainstorming)
**Targets:** `plugins/p-wiki` v4.5.0 → v4.6.0 (minor — additive frontmatter field, two new lint checks, two additive `set` flags)
**Predecessor:** `2026-05-11-p-wiki-plugin-design.md` (§3.5 lint, §4.4 compile rules)

---

## 1. Goal

Make unresolved factual conflicts and source-divergence **visible and tracked**, instead of living forever as free-text callouts that no tool ever surfaces.

### 1.1 Pains addressed

Today, when `compile` finds that a newer source contradicts an existing page, it follows §4.4 ("do not silently overwrite") and inserts a `> ⚠️ Conflict / superseded` callout into the body, leaving the old content in place. This is correct — but it is only half the pattern. The other half — surfacing and closing the conflict — is missing:

1. **The callout is free prose in the body.** No tool can detect it; it is invisible to `lint`.
2. **The conflict-target page's `updated` is moved to the flag date.** When `compile` touches a page to add a callout it ends up dated "today" (the skill edits the frontmatter directly, and the existing-page update path bumps `updated` anyway). This *masks* the only staleness signal: the 90-day `stale` check (`lint.mjs:64`) never fires on a freshly "updated" page. Observed: `pricing-engine` shows `updated: 2026-06-05` — the conflict date — so it reads as fresh.
3. **`lint` has no conflict check.** Its buckets are `dead-links`, `dead-sources`, `frontmatter`, `orphan-pages`, `underlinked`, `stale`. None see a callout.
4. **The `status` enum has `stale`** (`active | stale | draft`) but nothing ever sets it, and conflicts never downgrade status.
5. **Argument-less `compile` only reprocesses `raw/**` with `compiled: false`.** Pages synthesized from in-repo sources are never automatically revisited, so a source can change and the derived page silently rots.

Net effect: a conflict callout is silent technical debt with no lifecycle. Observed in the wild on `extrade/specifications` `pages/concept/pricing-engine.md`, superseded by ADR-0032/0033 on 2026-06-05 with no mechanism to ever surface or close it.

### 1.2 Prior art

- **ADRs** model supersession as a machine-readable **status field** (`Superseded by ADR-XXXX`) with two-way links, not just prose — the metadata, not the body, carries the signal. ([adr.github.io](https://adr.github.io/), [Microsoft WAF](https://learn.microsoft.com/en-us/azure/well-architected/architect-role/architecture-decision-record))
- **Docs-as-code freshness** runs a freshness score in CI on every PR, keyed on a source→docs map and a git-age delta, so a source change flags the dependent docs automatically. ([dosu.dev](https://dosu.dev/blog/score-documentation-freshness-in-ci))
- **KB tooling** flags conflicts to a human and surfaces an explicit "needs verification" state to the owner on a timer; archives rather than deletes. ([Fini](https://www.usefini.com/guides/ai-knowledge-base-conflicting-answers), [Cobbai](https://cobbai.com/blog/knowledge-base-content-quality))

Common lesson: model conflict/staleness as **structured state with a lifecycle**, and tie freshness to **source changes**, not the calendar.

### 1.3 Non-goals

- **Auto-resolving conflicts.** The "surface, don't overwrite" principle (§4.4) stays. This design surfaces and tracks; a human (or a later `compile`) still does the reconciliation.
- **Dedicated `conflicts` / `resolve` subcommands.** Listing is folded into `lint`; clearing is a flag on the existing `set`. No new top-level command.
- **`query`-time conflict warnings.** Valuable (KB "flag until resolved"), but deferred to Future work (§6).
- **Hashing / content-diff of sources.** Freshness uses the git commit date of each source — CI-stable and cheap. No snapshots, no hashes.
- **Touching the Confluence destination.** Conflict tracking is a content concern on the canonical FS pages; mirrors receive the field on the next `sync` for free (it is plain frontmatter). No Confluence-specific work.

---

## 2. Design

### 2.1 Structured marker — one source of truth

The machine-readable signal is a single **optional frontmatter field** on every editable page type:

```yaml
conflict-since: 2026-06-05   # date the unresolved conflict was first flagged; absent = no open conflict
```

The body callout stays as human-facing prose authored by `compile` (its wording, which sources, what is superseded — an LLM judgement). The frontmatter field is the **only** thing tools key off, so there is no body/metadata drift to keep in sync.

Standardized callout shape `compile` writes (prose is free, the leading marker is fixed):

```markdown
> ⚠️ Conflict (since 2026-06-05): <one-line summary of what is superseded and by what>. See [ADR-0032](./adr-0032-…md), [ADR-0033](./adr-0033-…md). Body below reflects the pre-conflict sources.
```

### 2.2 `compile` stops masking `updated`

`compile`'s conflict path changes (skill §4.4 / step 4d):

- **On inserting a callout** (conflict detected, body left intact): run `set --conflict-since <today>` — sets the field, **does not** bump `updated`. The page's `updated` keeps reflecting its last *reconciled* edit, so the 90-day `stale` check stays meaningful and is not reset by merely flagging a conflict.
- **On reconciling** (body rewritten to agree with the new source): run `set --clear-conflict` — removes the field **and** bumps `updated`, and the skill removes the body callout.

### 2.3 Two new `lint` checks

`runChecks` gains two warning buckets (same shape and severity tier as the existing `stale` warning):

1. **`conflicts`** — page has `conflict-since` set. Reports `{ file, since, days }` where `days = today − since`. Always a warning; aging escalation to error is left as an optional follow-up (§6) to keep the first cut simple.
2. **`source-changed`** — for each page, for each path in `sources:`, compare the source's last-commit date against the page's `updated`. If the source is newer, the derived page may be stale. Reports `{ file, source, sourceDate, pageUpdated }`. This is the docs-as-code freshness signal — it would have flagged `pricing-engine` automatically the moment ADR-0032/0033 were committed, with no manual `compile`.

`source-changed` needs source dates, which `runChecks` cannot compute purely. It is injected, mirroring the existing `existsFn` dependency:

```js
runChecks(docs, { repoRoot, existsFn, sourceDateFn })
```

- `sourceDateFn(relPath) -> 'YYYY-MM-DD' | null` — real impl (in `fs.mjs`) shells to `git log -1 --format=%cs -- <path>`; returns `null` for untracked/non-git paths, in which case the check is skipped for that source. CI-stable (commit date, not mtime).
- When `sourceDateFn` is omitted (existing callers, unit tests that don't exercise it), the `source-changed` check is skipped — fully backward compatible.

### 2.4 Schema

`conflict-since` is added to the **allowed** (not required) field set for `concept`, `person`, `source`, and `query`, and `validateFrontmatter` rejects it if present and not matching `^\d{4}-\d{2}-\d{2}$`.

Caveat (verified in code): `allowedFields` is currently an unused export — `validateFrontmatter` does not reject unknown fields, so a page carrying `conflict-since` already validates today. The allowed-list edit is therefore for documentation/consistency; the **only functional new validation is the date-format check**. Required-field sets are unchanged, so every existing page validates as-is.

### 2.5 `set` CLI surface

Two additive flags on the existing `set` command, expressed through the existing `mutatePage` mutation shape (which already supports `setFields`, `removeFields`, `bumpUpdated` — see `promote`):

| Flag | Mutation | Effect |
|---|---|---|
| `--conflict-since <YYYY-MM-DD>` | `setFields: { 'conflict-since': <date> }`, no `bumpUpdated` | Set the field; `updated` untouched (`mutatePage` only bumps when `bumpUpdated` is passed). |
| `--clear-conflict` | `removeFields: ['conflict-since']`, `bumpUpdated: true` | Remove the field and bump `updated` (reconciliation is a real edit). |

The CLI validates `--conflict-since` against the date regex before building the mutation. No new top-level command. `lint` is the listing surface; `set` is the mutation surface.

---

## 3. Affected files

| Path | Change |
|---|---|
| `tools/lib/schema.mjs` | `conflict-since` added to allowed sets; date-format validation |
| `tools/lib/lint.mjs` | Two new warning buckets; `sourceDateFn` dependency |
| `tools/lib/destinations/fs.mjs` | `lint()` passes a git-backed `sourceDateFn` |
| `tools/pwiki.mjs` | `set` gains `--conflict-since` / `--clear-conflict`; CLI `VERSION` `3.0.0` → `3.1.0` (independent of plugin version) |
| `skills/compile/SKILL.md` | §4.4/step 4d: standardized callout + `--conflict-since` (no `--bump-updated`); reconciliation path uses `--clear-conflict` |
| `skills/lint/SKILL.md` | Document the two new checks in the report |
| `skills/_shared/templates/wiki-claude-md.template.md` | Document `conflict-since` + callout convention (auto-loaded guidance) |
| `docs/superpowers/specs/2026-05-11-p-wiki-plugin-design.md` | §3.5 + §4.4 updated to reference conflict tracking |
| `.claude-plugin/plugin.json` | `"version": "4.6.0"` |

---

## 4. Backward compatibility

Every change is additive. Existing wikis: pages without `conflict-since` validate unchanged and produce no new warnings. The `source-changed` check is the only behavioural addition that can surface warnings on existing pages — which is the point (it retroactively flags already-divergent pages). No migration, no breaking change → **minor** bump.

---

## 5. Test strategy

- `schema.test.ts` — `conflict-since` accepted when valid, rejected when malformed; required sets unchanged.
- `lint.test.ts` — `conflicts` bucket fires on a page with the field and not without; `source-changed` fires when injected `sourceDateFn` returns a date later than `updated`, and is skipped when `sourceDateFn` is absent.
- `cli-set.test.ts` — `--conflict-since` sets the field and leaves `updated` untouched; `--clear-conflict` removes it and bumps `updated`.
- `fs.mjs` git-backed `sourceDateFn` covered via a temp git repo fixture in the lint integration test.

---

## 6. Future work (out of scope here)

- **Aging escalation:** move `conflicts` older than N days from warning to error so CI fails on long-rotting conflicts.
- **`query`-time awareness:** `/p-wiki:query` warns when an answer cites a page with an open `conflict-since`.
- **`compile` auto-reconcile guarantee:** make the skill always attempt reconciliation (and clear the flag) when re-run on a source that feeds a conflicted page, rather than leaving it to chance.
