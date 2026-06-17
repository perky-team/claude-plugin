# Design: `p-wiki:sync` skill — chat-invocable wrapper over `pwiki sync`

**Date:** 2026-06-17
**Status:** Drafted (brainstorming)
**Targets:** `plugins/p-wiki` v4.9.0 → v4.10.0 (minor bump — additive new skill)
**Predecessor:** `2026-05-18-pwiki-v3-multi-destination-sync-design.md` (§7 revisited)

---

## 1. Goal

Expose the already-built, already-tested `pwiki sync` CLI command (multi-destination
mirror sync, design v3) as a slash command `/p-wiki:sync`, so a user can trigger a
primary → mirrors sync from chat without dropping to the shell.

The skill is a **thin wrapper**: it adds pre-flight checks and a readable summary, but
contains **no sync logic of its own**. All sync behavior remains in
`tools/lib/sync.mjs` and `tools/pwiki.mjs` and is exercised by the existing
`sync.test.ts`, `sync-unit.test.ts`, and `cli-sync.test.ts` suites.

### 1.1 Why this reverses v3 §7

The v3 design (`2026-05-18-…`) §7 concluded a `sync` skill was *not* worth adding:
"Sync is a maintenance operation, invoked via the CLI directly or via cron. Wrapping
it in a slash command is trivial later if invocation frequency is high."

That call is now revisited. In practice sync is run interactively from chat (publish a
markdown wiki to Confluence, refresh an FS backup of a Confluence wiki), and dropping
to the shell for `node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" sync` is friction. The
sibling plugin `p-tasks` already ships a `sync` skill over the same one-way mirror
model, so p-wiki was the odd one out. The "trivial to add later" condition is met — so
we add it. The wrapper is intentionally trivial, matching v3's expectation.

### 1.2 Non-goals

- **No new CLI flags or modes.** `--dry-run` and `--to <mirror>` remain deferred (v3
  §5.3 / §10). The skill calls bare `pwiki sync` only. YAGNI.
- **No sync logic in the skill.** The skill never re-implements passes, deletion, or
  cross-link rewriting. It shells out to the CLI.
- **No bidirectional/selective sync.** Same constraints as v3.

---

## 2. Behavior

### 2.1 Pre-flight

1. **Locate the wiki.** `<root>` = `git rev-parse --show-toplevel`; confirm
   `<root>/docs/wiki/CLAUDE.md` exists (same repo marker as `/p-wiki:lint`). If not,
   stop: not inside a p-wiki repo.
2. **Read config.** Read `<root>/docs/wiki/.pwiki.json`.
   - File absent → FS-only default, `mirrors: []`.
   - `mirrors` empty or missing → stop with a friendly note: sync copies primary →
     mirrors and this wiki has no mirrors configured, so there is nothing to do. Not an
     error.
3. **Confluence credentials.** Collect the destinations sync will touch: `primary` plus
   every name in `mirrors`. If any of those `destinations[name].kind === "confluence"`,
   verify `PWIKI_CONFLUENCE_EMAIL` and `PWIKI_CONFLUENCE_TOKEN` are set. If either is
   missing, stop with instructions linking to
   <https://id.atlassian.com/manage-profile/security/api-tokens>. (The CLI would
   otherwise fail with `auth-failed`; catching it pre-flight gives a clearer message.)

### 2.2 Pre-run notice (no blocking confirmation)

Before running, print one concise notice naming the mirrors that will be written and
the three semantic facts the user must be aware of: sync is **one-way** (primary →
mirrors), mirror **manual edits are overwritten**, and **mirror-only pages are
deleted** (true-mirror). Then run immediately — no `y/N` prompt.

Rationale: sync is idempotent and routine; the user explicitly invoked it; `p-tasks:sync`
sets the precedent of running directly; and overwriting mirrors is by-design (v3 §1.2 —
mirrors are not working copies). A blocking prompt on every run would be naggy. The
notice keeps the destructive aspect visible without gating it.

### 2.3 Run and report

Run `node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" sync --format=json` and parse the
result. For each entry in `mirrors`, report: mirror name, written / rewritten / deleted
counts, warnings, and elapsed time. Summarize totals across mirrors.

JSON (not text) mode is used so per-mirror counters and per-mirror `error` objects can
be rendered cleanly and a partial-failure run can be explained precisely. This mirrors
`p-tasks:sync` (`ptasks.mjs sync --json`).

### 2.4 Error handling

The CLI exit codes (v3 §5.1): 0 all mirrors ok, 1 ≥1 mirror failed, 2 config-invalid,
3 internal. On non-zero exit, surface the JSON `error.code` / per-mirror
`mirrors[].error` verbatim — do not swallow. Reuse the same `error.code → message`
table as `/p-wiki:lint` (auth-failed, config-invalid, rate-limited, network-error,
version-conflict, internal). Remind the user sync is idempotent and safe to re-run after
a partial failure (v3 §3.2).

---

## 3. Docs to bring in sync

- **README** — add `/p-wiki:sync` to the commands table; delete the "It's a CLI command,
  not a skill, so it isn't in the table above" sentence.
- **v3 design §7** — add a note that the skill decision is revisited, linking here.
- **`p-wiki-rule.template.md`** — add `/p-wiki:sync` to the maintenance-commands list so
  generated wikis advertise it.
- **`wiki-claude-md.template.md`** — mention `/p-wiki:sync` alongside the `pwiki sync`
  CLI invocation in the multi-destination section.
- **`marketplace.json`** + **`plugin.json`** — append `sync` to the listed skill names.

---

## 4. Testing

No new automated tests: the skill adds no executable logic, only orchestration of an
already-tested CLI. The sync algorithm is covered by `sync.test.ts`,
`sync-unit.test.ts`, and the CLI surface by `cli-sync.test.ts`. Manual verification:
run `/p-wiki:sync` against an FS-primary + Confluence-mirror wiki and against an
FS-only (no-mirror) wiki to confirm both the happy path and the "nothing to sync" path.
