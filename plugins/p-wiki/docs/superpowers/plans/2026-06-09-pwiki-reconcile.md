# pwiki `/p-wiki:reconcile` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/p-wiki:reconcile` skill that sweeps the wiki, finds conflict callouts and stale (source-changed) pages, and — for supersession cases — rewrites the body to agree with current sources and removes the callout. Genuine unresolved conflicts are left flagged for a human. Resolution lives here; `compile` keeps flagging, `lint` keeps reporting.

**Architecture:** Reconcile is a **skill** (LLM-driven merge), not a CLI subcommand. It reuses `pwiki lint --format=json` for targeting and the already-built `pwiki set --clear-conflict` / `--add-source` / `backlinks` / `index` for mutation. The only code change is a lint enhancement so the `conflicts` check detects body callout markers (not just the `conflict-since` frontmatter flag), which makes legacy callouts like `pricing-engine` visible and targetable — folding the earlier "backfill" gap into normal detection.

**Tech Stack:** Node ≥ 18 stdlib, vitest + TypeScript for the lint change. The skill is markdown. No new npm dependencies, no new `pwiki` subcommand.

**Spec:** [`2026-06-09-pwiki-reconcile-design.md`](../specs/2026-06-09-pwiki-reconcile-design.md)

---

## File Structure

**New files:**

| Path | Responsibility |
|---|---|
| `skills/reconcile/SKILL.md` | The reconcile flow: target → classify → merge/leave → report |

**Modified files:**

| Path | What changes |
|---|---|
| `tools/lib/lint.mjs` | `conflicts` check detects a body callout marker; age from `conflict-since` ∥ marker date ∥ `null` |
| `tools/__tests__/lint.test.ts` | Body-marker detection cases |
| `tools/pwiki.mjs` | `formatLintReport` conflicts line tolerates unknown age; CLI `VERSION` `3.1.0` → `3.2.0` |
| `tools/__tests__/cli-entry.test.ts` | Version assertion `3.1.0` → `3.2.0` |
| `skills/compile/SKILL.md` | One line: callouts it drops are closed by `/p-wiki:reconcile` |
| `skills/lint/SKILL.md` | Conflicts now include unflagged legacy callouts; point at `/p-wiki:reconcile` |
| `skills/_shared/templates/wiki-claude-md.template.md` | Document the reconcile verb |
| `.claude-plugin/plugin.json` | `"version": "4.7.0"`; description adds `reconcile` |
| `.claude-plugin/marketplace.json` (repo root) | p-wiki description adds `reconcile` |
| `docs/superpowers/specs/2026-05-11-p-wiki-plugin-design.md` | §4.4 cross-reference reconcile |

---

## Layer roadmap

- **Layer 1 (Task 1):** Lint detects body callout markers — legacy callouts become visible/targetable. TDD.
- **Layer 2 (Task 2):** The `reconcile` SKILL.md.
- **Layer 3 (Tasks 3–5):** Registration, cross-references, version bumps, full suite, live verification.

Run `npm test` after each code task.

---

## Layer 1 — Lint detects body callouts

### Task 1: `conflicts` check keys off body marker, not just frontmatter

**Files:**
- Modify: `plugins/p-wiki/tools/lib/lint.mjs`
- Modify: `plugins/p-wiki/tools/__tests__/lint.test.ts`
- Modify: `plugins/p-wiki/tools/pwiki.mjs` (`formatLintReport`)

- [ ] **Step 1: Failing tests** (add to `lint.test.ts`)

```ts
it('flags an unflagged legacy body callout (pricing-engine shape)', () => {
  const c = validConcept('a');
  c.body = `# A\n\n> ⚠️ Partially superseded (2026-06-05): old model replaced. See [x](./x.md).\n\nbody\n[a](./b.md)\n`;
  const r = runChecks([c], { repoRoot: '/x', existsFn: () => true });
  expect(r.warnings.conflicts).toHaveLength(1);
  expect(r.warnings.conflicts[0]).toMatchObject({ file: c.path, since: '2026-06-05' });
});

it('flags a body conflict callout with no parseable date (since: null)', () => {
  const c = validConcept('a');
  c.body = `# A\n\n> ⚠️ Conflict: source X disagrees with source Y.\n\n[a](./b.md)\n`;
  const r = runChecks([c], { repoRoot: '/x', existsFn: () => true });
  expect(r.warnings.conflicts).toHaveLength(1);
  expect(r.warnings.conflicts[0].since).toBeNull();
});

it('prefers the frontmatter conflict-since over the marker date', () => {
  const c = validConcept('a', { 'conflict-since': '2026-06-01' });
  c.body = `# A\n\n> ⚠️ Conflict (since 2026-06-05): ...\n\n[a](./b.md)\n`;
  const r = runChecks([c], { repoRoot: '/x', existsFn: () => true });
  expect(r.warnings.conflicts[0].since).toBe('2026-06-01');
});

it('does not flag a page with neither a flag nor a callout', () => {
  const r = runChecks([validConcept('a')], { repoRoot: '/x', existsFn: () => true });
  expect(r.warnings.conflicts).toEqual([]);
});
```

(Keep the existing "flags a page with conflict-since" test — it still passes.)

- [ ] **Step 2: Implement** in `lint.mjs`. Replace the current `conflict-since`-only check with marker-aware detection:

```js
// A body conflict callout: a blockquote line with the warning sign and
// "conflict"/"superseded". Carries an optional "(since YYYY-MM-DD)" date.
const CONFLICT_MARKER = /^\s*>\s*⚠️.*\b(conflict|superseded)\b/im;
const MARKER_DATE = /\(since\s+(\d{4}-\d{2}-\d{2})\)/i;

// ... inside the per-doc loop, replacing the existing conflicts push:
const flag = d.frontmatter['conflict-since'] ?? null;
const hasCallout = CONFLICT_MARKER.test(d.body ?? '');
if (flag || hasCallout) {
  const markerDate = (d.body?.match(MARKER_DATE)?.[1]) ?? null;
  const since = flag ?? markerDate;            // frontmatter wins, else marker date, else null
  warnings.conflicts.push({
    file: d.path,
    since,
    days: since ? daysBetween(since, todayStr) : null,
  });
}
```

- [ ] **Step 3:** In `pwiki.mjs` `formatLintReport`, make the conflicts line tolerate a null age:

```js
['Conflicts (warnings)', r.warnings.conflicts ?? [], (e) =>
  `  - ${e.file} — unresolved conflict${e.since ? ` since ${e.since} (${e.days} days)` : ' (date unknown)'}`],
```

- [ ] **Step 4: `npm test` green** (schema, lint, cli-lint, cli-set unaffected).

---

## Layer 2 — The reconcile skill

### Task 2: Write `skills/reconcile/SKILL.md`

**Files:**
- Create: `plugins/p-wiki/skills/reconcile/SKILL.md`

- [ ] Frontmatter (match the house format used by `compile`/`lint`):
  - `name: reconcile`
  - `description:` — synthesize: "Resolve conflict callouts and stale pages: re-merge a derived page with its current sources and remove the superseded callout. Use when the user says 'reconcile', 'свести', 'resolve conflicts', 'remove superseded callouts', or after lint reports conflicts."
  - `argument-hint: "[<path>]"`
  - `allowed-tools: Bash(git rev-parse:*) Bash(node:*) Read Write Edit Grep Glob`

- [ ] Body — encode the §2.3 flow:
  1. **Find the wiki** — `<root>` via `git rev-parse --show-toplevel`; confirm `docs/wiki/CLAUDE.md`. With `$ARGUMENTS` a path → single-page mode.
  2. **Collect targets** — `pwiki lint --format=json`; union `warnings.conflicts` (callouts) and `warnings['source-changed']` (stale). Partition into *conflicts* and *stale-only*.
  3. **Confirm scope** — show counts + a sample. Default: process **conflicts** only. Offer: conflicts only / conflicts + stale / a path or glob. (Mass rewrite is an outward change — confirm before writing.)
  4. **Per page:**
     - Read page (frontmatter + body).
     - Gather authoritative sources: callout-linked sources (e.g. ADRs) + changed sources + existing `sources:`. Read them.
     - **Classify** supersession vs genuine conflict (see decision rules below). Default to *leave* when unsure.
     - **Supersession:** rewrite the stale body sections to current truth; remove the callout; [Markdown sanitization]; then
       `pwiki set <path> --clear-conflict --add-source "<src>" --format=json`.
     - **Genuine conflict:** leave the callout; ensure a flag via `pwiki set <path> --conflict-since <date>` (date from the marker or today) if none; add to the human-review list; do not rewrite.
  5. **Post-steps** (mirror compile): `pwiki backlinks <path>` per touched page, then once `pwiki index`.
  6. **Report:** reconciled / left-for-human (with reasons) / no-ops / backlinks added / index regenerated.

- [ ] **Decision rules** section — concrete heuristics:
  - Supersession when: the newer source is an accepted decision that "supersedes"/"replaces" the prior model, or a source revised after the page covering the same topic, and the page's claims are a strict subset/older version of it.
  - Genuine conflict when: two *currently-valid* sources state incompatible facts with no supersession relation.
  - Conservative default: leave + flag.

- [ ] **Markdown sanitization** section — reuse the exact wording from `compile/SKILL.md` (wrap bare `<word>` tokens in backticks).

- [ ] **Error handling** section — reuse the `error.code` table from `compile`/`lint` SKILLs.

- [ ] **Edge cases** — empty target set → "Nothing to reconcile."; single-path mode on a clean page → no-op report; a page exceeding 2000 words after merge → flag, suggest split (don't auto-split, same as compile).

---

## Layer 3 — Registration, cross-refs, ship

### Task 3: Register the skill

**Files:**
- Modify: `plugins/p-wiki/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

- [ ] Update both `description` strings: `Skills: init, ingest, compile, query, lint, reconcile.`
- [ ] Bump `plugin.json` `"version"` to `"4.7.0"`.

### Task 4: Cross-references

**Files:**
- Modify: `plugins/p-wiki/skills/compile/SKILL.md`
- Modify: `plugins/p-wiki/skills/lint/SKILL.md`
- Modify: `plugins/p-wiki/skills/_shared/templates/wiki-claude-md.template.md`
- Modify: `plugins/p-wiki/docs/superpowers/specs/2026-05-11-p-wiki-plugin-design.md`

- [ ] `compile/SKILL.md`: after the conflict-callout block, add one line — "Callouts left here are closed later by `/p-wiki:reconcile`, which merges the page with its current sources."
- [ ] `lint/SKILL.md`: note Conflicts now also includes legacy callouts without a `conflict-since` flag; the fix is `/p-wiki:reconcile`.
- [ ] CLAUDE.md template: add `reconcile` to the verb story (compile flags, reconcile resolves, lint reports).
- [ ] Original design spec §4.4: cross-reference reconcile as the resolution step for callouts.

### Task 5: Version bump, full suite, live verification

**Files:**
- Modify: `plugins/p-wiki/tools/pwiki.mjs` (CLI `VERSION`)
- Modify: `plugins/p-wiki/tools/__tests__/cli-entry.test.ts`

- [ ] Bump CLI `VERSION` `'3.1.0'` → `'3.2.0'`; update `cli-entry.test.ts` assertion.
- [ ] `npm test` — full suite green; `npm run validate` — manifests pass.
- [ ] **Live verification** on `C:\projects\extrade\specifications` (requires the user's explicit go-ahead — first write to that repo):
  - `/p-wiki:reconcile docs/wiki/pages/concept/pricing-engine.md`
  - Expect: callout removed, `Four-layer pipeline` section rewritten to the channel-centric model, ADR-0032/0033 added to `sources:`, `updated` bumped.
  - Review with `git diff`; confirm `pwiki lint` no longer lists the page under Conflicts.

---

## Done criteria

- `/p-wiki:reconcile` with no args sweeps conflicts (and, on opt-in, stale pages), merges supersession cases, removes their callouts, and leaves genuine conflicts flagged with a report.
- `pwiki lint` lists legacy body callouts (no frontmatter flag) under Conflicts.
- A reconciled page has no callout, current `sources:`, bumped `updated`, and is clean on the next lint.
- Full test suite green; manifests valid; `plugin.json` at `4.7.0`, CLI at `3.2.0`.
