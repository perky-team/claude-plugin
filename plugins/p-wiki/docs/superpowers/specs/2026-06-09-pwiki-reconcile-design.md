# Design: `/p-wiki:reconcile` — close conflict callouts by merging documents

**Date:** 2026-06-09
**Status:** Drafted (brainstorming)
**Targets:** `plugins/p-wiki` v4.6.0 → v4.7.0 (minor — new skill + additive lint enhancement)
**Predecessors:** `2026-05-11-p-wiki-plugin-design.md` (§4.4 compile rules), `2026-06-08-pwiki-conflict-tracking-design.md` (detection: `conflict-since`, lint `conflicts`/`source-changed`)

---

## 1. Goal

Give the wiki an explicit way to **resolve** conflict callouts — rewrite the affected document to agree with its current sources and remove the callout — so superseded knowledge gets reconciled instead of accumulating forever.

The prior conflict-tracking work added the **detection** half (a callout leaves a `conflict-since` flag; `lint` surfaces conflicts and source-divergence). It deliberately did NOT resolve anything. This design adds the missing **resolution** half: a `/p-wiki:reconcile` skill that sweeps flagged pages and merges them.

### 1.1 The three verbs (how the pieces fit)

- **`compile`** — *ingest knowledge from a source.* On a contradiction it drops a callout and records a `conflict-since` flag (unchanged here — compile still flags, it does not resolve inline).
- **`reconcile`** *(new)* — *sweep the wiki and close what accumulated.* Finds pages with callouts / changed sources, re-synthesizes the body from current sources, removes resolved callouts. This is the guard against forever-accumulation.
- **`lint`** — *report what is still open.* Detection / visibility only.

`compile` works forward, `reconcile` catches up the tail, `lint` shows the remainder.

### 1.2 Non-goals

- **Auto-deciding genuine conflicts.** When two *currently-valid* sources truly disagree (no supersession), reconcile leaves the callout and reports it for a human. It never silently picks a winner.
- **Inline auto-resolve inside `compile`.** Compile keeps flagging; resolution lives in one place (reconcile). Keeps compile focused and reconciliation logic single-homed.
- **A deterministic CLI that "merges".** Merging is an LLM content judgement (read sources, rewrite prose). Reconcile is therefore a **skill**, not a `pwiki` subcommand. The CLI only provides targeting (`lint`) and the frontmatter mutations (`set`), which already exist.
- **Unattended mass rewrite.** A sweep that rewrites many pages is an outward content change; the skill confirms scope before writing and the user reviews via `git diff`.

---

## 2. Design

### 2.1 What counts as a reconcile target

Three signals, all already (or nearly) surfaced by `pwiki lint --format=json`:

1. **Conflict callout in the body** — any blockquote line mentioning `conflict`/`superseded` (case-insensitive), covering the `> ⚠️ …`, `> **Superseded …**`, and `> **Note:** … superseded …` shapes. (The marker must not be hardcoded to `⚠️` — a live audit of the `specifications` wiki found two superseded notices in the bold format that an `⚠️`-only regex missed.) This is the durable, human-visible "needs resolving" marker. It catches both new callouts and **legacy ones written before the `conflict-since` field existed** (e.g. `pricing-engine`, whose callout has no frontmatter flag).
2. **`conflict-since` frontmatter flag** — companion to (1) on callouts written by the current `compile`.
3. **`source-changed`** — a `sources:` path committed (git) after the page's `updated` date; the page may no longer reflect its source.

Sets (1)+(2) are the **conflicts** (the plashki to remove). Set (3) is **stale pages** (re-compile candidates) and is much larger (187 on the `specifications` wiki today).

### 2.2 Lint enhancement so targeting is honest

Today `lint`'s `conflicts` check keys off the `conflict-since` frontmatter only, so a legacy body callout with no flag (like `pricing-engine`) is invisible. This design **extends the `conflicts` check to also detect the body callout marker** (any blockquote with `conflict`/`superseded`, §2.1.1), deriving age from `conflict-since` if present, else from a `(since YYYY-MM-DD)`/`(YYYY-MM-DD)` date parsed out of the marker, else reporting age as unknown. Effect: every open callout — legacy or new — appears in `lint` and is a reconcile target. This folds the earlier "backfill" gap into the normal detection path; no separate backfill step is needed.

**Decision-page exclusion.** ADR / decision pages keep a "superseded by …" notice **permanently** by convention — an immutable decision record pointing to its successor (see the ADR prior-art in `2026-06-08-pwiki-conflict-tracking-design.md` §1.2). Such notices are *not* debt and must not be reconciled away. The `conflicts` check therefore excludes pages whose filename / `id` / `title` begins with `adr-<digit>` (case-insensitive). Verified on `specifications`: `adr-0018-synthetic-depth-ladder` and `adr-0024-ps-input-failover-module-gating` carry `> **Superseded …**` notices and are correctly **not** flagged, while the concept-page plashki (`channel`, `pricing-engine`, `synthetic-depth`) are.

### 2.3 Reconcile flow (the skill)

1. **Find the wiki** (`git rev-parse --show-toplevel`; confirm `docs/wiki/CLAUDE.md`). With a path arg → operate on that one page only.
2. **Collect targets** via `pwiki lint --format=json`: union of `conflicts` (callouts) and `source-changed` (stale). Partition into *conflicts* and *stale-only*.
3. **Confirm scope.** Show counts and a sample. Default action: process **conflicts** (the plashki). The **stale-only** set is processed only on explicit opt-in, because re-compiling 100+ pages is a different-magnitude operation. Offer: conflicts only / conflicts + stale / a specific path or glob.
4. **Per page** (LLM work):
   a. Read the page (frontmatter + body, including any callout).
   b. Gather the authoritative sources: for a callout, the sources it links to (e.g. ADR-0032/0033) plus the page's existing `sources:`; for a stale page, the changed source(s) plus existing `sources:`. Read them.
   c. **Classify:**
      - **Supersession / stale-update** — a newer source clearly replaces the old model (accepted ADR with "supersedes" semantics, or a source revised after the page). → **Reconcile.**
      - **Genuine unresolved conflict** — two current sources disagree with no supersession. → **Leave the callout**, ensure a `conflict-since` flag exists (set it if missing — this also backfills legacy callouts that turn out to be true conflicts), skip the body rewrite, add to the human-review list.
      - When unsure, default to *leave* (conservative).
   d. **For reconcile:** rewrite the affected body sections to match the current sources, remove the callout, apply [Markdown sanitization]. Then:
      ```bash
      pwiki set <path> --clear-conflict --add-source "<new-source>" --format=json   # clears flag (if any) + bumps updated + records sources
      ```
      (For a stale-only page with no callout/flag, `--clear-conflict` is a safe no-op on the field and still bumps `updated`.)
   e. Run the same post-steps as compile: `pwiki backlinks <path>` for touched pages, then once at the end `pwiki index`.
5. **Report:** N reconciled, M left for human (with reasons), K no-ops, backlinks added, index regenerated.

### 2.4 Idempotency

A page with no callout and not source-changed is skipped. Re-running reconcile after a clean pass is a no-op. Reconciling a page that was already reconciled (callout gone, sources current) does nothing.

### 2.5 CLI surface

**No new `pwiki` subcommand.** Reconcile reuses:
- `pwiki lint --format=json` — targeting (with the §2.2 enhancement).
- `pwiki set --clear-conflict` / `--add-source` / `--conflict-since` — frontmatter (all built in the conflict-tracking work).
- `pwiki backlinks`, `pwiki index` — post-steps (exist).

The only code change is the §2.2 lint enhancement.

---

## 3. Affected files

| Path | Change |
|---|---|
| `tools/lib/lint.mjs` | `conflicts` check also detects a body callout marker; age from `conflict-since` ∥ marker date ∥ `null` |
| `tools/__tests__/lint.test.ts` | Cases for body-marker detection (flagged, unflagged-legacy, none) |
| `tools/pwiki.mjs` | `formatLintReport` conflicts line tolerates `null`/unknown age; CLI `VERSION` `3.1.0` → `3.2.0` |
| `skills/reconcile/SKILL.md` | **New skill** — the reconcile flow (§2.3) |
| `skills/compile/SKILL.md` | One line pointing at `/p-wiki:reconcile` as the resolution path for the callouts it drops |
| `skills/lint/SKILL.md` | Note that conflicts now include unflagged legacy callouts; suggest `/p-wiki:reconcile` |
| `skills/_shared/templates/wiki-claude-md.template.md` | Document the reconcile verb alongside compile/lint |
| `.claude-plugin/plugin.json` | `"version": "4.7.0"`; description "Skills: …, reconcile" |
| `.claude-plugin/marketplace.json` (repo root) | p-wiki entry description "Skills: …, reconcile" |
| `docs/superpowers/specs/2026-05-11-p-wiki-plugin-design.md` | §4.4 cross-reference reconcile as the resolution step |

---

## 4. Backward compatibility

Additive. The lint change only broadens what `conflicts` reports (now also legacy body callouts) — strictly more visibility, no schema or behaviour break. New skill is purely additive. Minor bump.

---

## 5. Test strategy

- `lint.test.ts` — `conflicts` fires on a page whose **body** has a `⚠️ … superseded` callout but no frontmatter flag (the `pricing-engine` shape); still fires on `conflict-since`; age parsed from the marker when no flag; no false positive on a page with neither.
- The reconcile **skill** is prose (LLM-driven), not unit-tested. Its correctness is validated by a live run on the `specifications` wiki: reconcile `pricing-engine` → callout removed, body matches ADR-0032/0033, `sources:` updated, `git diff` reviewed.

---

## 6. Open question for review

**Default sweep scope.** Conflicts (the plashki) are the stated pain and a small set — process by default. The 187 `source-changed` pages are a much larger re-compile job. Proposed: process conflicts by default, require explicit opt-in for the stale set. Alternative: treat both equally and always confirm the full count first. Recommendation: the former (conflicts-first), since "remove the plashki" is the actual goal.
