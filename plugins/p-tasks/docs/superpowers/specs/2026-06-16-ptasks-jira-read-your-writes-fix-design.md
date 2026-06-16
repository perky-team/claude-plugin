# Design: p-tasks Jira backend — read-your-writes, init transport, exit crash

**Date:** 2026-06-16
**Status:** Implemented
**Targets:** `plugins/p-tasks` v0.2.1 → v0.2.2 (patch — bug fixes; the Jira backend now works correctly from the CLI against live Jira)
**Predecessor:** `2026-05-20-p-tasks-plugin-design.md`

---

## 1. Context

The Jira destination and its gated `jira-e2e.test.ts` existed but had never been
exercised through the CLI against a live Jira project. Running it live (project
`PMOCMT` on `exinity.atlassian.net`) surfaced three real defects. Unlike the
p-wiki Confluence backend, p-tasks identifies issues by their Jira **key**
(returned on create), so there is no property-search identity bug, and the CLI
command handlers already `await` the async destination.

## 2. Bugs and fixes

### 2.1 Read-your-writes: `set`/`add` resolved items via JQL search

`setCommand` found its target with `listItems()` (a JQL `search/jql` query) and
`add`/`set` validated blockers the same way. **Jira's JQL search index is
eventually consistent** — an issue created moments earlier is often missing from
search results even though it is directly readable by key. So
`ptasks set <freshly-created-key> --status …` could fail with `item-not-found`,
and `--blocked-by <fresh-key>` with `blocker-not-found`.

**Fix:** resolve the target with `readItem(id)` (direct `GET /issue/{key}`,
read-your-writes); validate each blocker by key (`readItem`) when it's absent
from the search list; and make sure the target node is present in the cycle
graph even if search hasn't indexed it. listItems is still used only to build
the dependency graph for cycle detection (inherently a whole-set operation).

### 2.2 `init --primary=jira` crashed with "transport is not a function"

The CLI dispatch calls `initWithArgs({ root, args })` with no transport, and the
jira probe inside `initWithArgs` built the destination via `createJiraDestination`
directly — bypassing the `transport ?? makeTransport()` fallback that lives in
`buildDestination`. So `createHttpClient` invoked `undefined(req)`.

**Fix:** the probe defaults to `makeTransport()` when no transport is injected.

### 2.3 CLI crashed on exit with code 127 (libuv UV_HANDLE_CLOSING)

`makeTransport` used `globalThis.fetch` (undici). The CLI calls `process.exit()`
immediately after a request resolves; undici's keep-alive socket pool is still
tearing down at that point, tripping a libuv assertion that crashes the process
with a non-zero exit code on Windows (`init --primary=jira` printed correct JSON
but exited 127).

**Fix:** `makeTransport` uses `node:https` with a per-request `keepAlive:false`
agent, so the socket closes before exit. (The same fix was applied to p-wiki's
`makeRealTransport`, which had the identical latent crash.)

### 2.4 `add --blocked-by` did not create the Jira link

Jira `createItem` skipped blocker links entirely (comment: "handled by sync pass
4 or an explicit set call"), so `ptasks add task --blocked-by X` reported
`blockedBy:[X]` but created **no** link in Jira. (FS persists it; only Jira
didn't.)

**Fix:** `createItem` now creates a Blocks link for each `input.blockedBy`. The
CLI validates blockers exist first, so the targets are present. Sync is
unaffected — it deliberately omits `blockedBy` from `createItem` and reconciles
links in its own later pass once every mirror issue exists (forward references).

### 2.5 `sync` to a Jira mirror created a duplicate issue every run

Sync matched existing mirror issues via `mirror.listItems()` (JQL search). Jira's
search index lags, so on the next run the issue created moments earlier was
absent from the list → sync re-created it → a fresh duplicate Jira issue on
**every** sync (verified live: `created:1` on runs 1, 2 and 3).

**Fix:** when a mapped key is already known (a prior sync stored it), resolve the
existing mirror issue by key via `readItem` (read-your-writes) before deciding
it's missing (`resolveExisting` in sync). Now re-sync is idempotent
(`created:0`), and a primary-side edit yields `updated:1`, with no duplicates.

## 3. Affected files

| Path | Change |
|---|---|
| `tools/ptasks.mjs` | `set` resolves target via `readItem`; `set`/`add` validate blockers by key; thread `transport` through `add`/`set`/`next`/`summary`; init probe falls back to `makeTransport()`; CLI `VERSION` `0.1.0` → `0.1.1` |
| `tools/lib/destination.mjs` | export `makeTransport`; switch it to `node:https` (`keepAlive:false`) |
| `tools/lib/destinations/jira.mjs` | `createItem` creates Blocks links for `input.blockedBy` |
| `tools/lib/sync.mjs` | `resolveExisting` — match a mirrored issue by key (read-your-writes) so re-sync doesn't duplicate when JQL search lags |
| `tools/__tests__/cli-set-jira.test.ts` | **new** — read-your-writes regression tests (fake models JQL lag: readable by key, absent from search) |
| `tools/__tests__/cli-next-summary-jira.test.ts` | **new** — `next`/`summary` over Jira data: blocked-task skip, unblock after blocker done, done-only summary |
| `tools/__tests__/cli-e2e.test.ts` | `vi.setConfig({ testTimeout: 30_000 })` — the spawn-heavy file sat at ~4.5 s vs the 5 s default and flaked under parallel CPU contention |
| `.claude-plugin/plugin.json` | `"version": "0.2.2"` |

## 4. Verification

- Unit suite green (`npx vitest run plugins/p-tasks`), incl. the 3 new
  read-your-writes tests (which fail on the old `listItems` resolution).
- Live (`PTASKS_E2E_JIRA=1`, project `PMOCMT`): `jira-e2e.test.ts` 6/6; CLI
  `init → add → set → next` all exit 0; `set` immediately after `add` confirms
  read-your-writes; no libuv crash. `next`/`summary` confirmed live — marking an
  existing issue `done` makes `summary` list it and `next` exclude it.
- Live blocker flow: real Blocks link created via `add --blocked-by` (verified
  through the raw API); `next` excludes the blocked issue and surfaces it again
  once the blocker is `done`.
- Live `sync` (fs primary → jira mirror): tasks/sub-tasks/blocker links + status
  mirrored correctly; re-sync is idempotent (`created:0`); a primary edit yields
  `updated:1` — no duplicate issues.
- Full repo suite green under both parallel and serial runs (the cli-e2e flake
  no longer reproduces).

## 5. Known gaps / notes

- **Cycle detection and `next`/`summary`/`sync` still read the whole set via
  `listItems` (JQL).** A just-created item may be briefly missing there; the
  target/blocker paths are now read-your-writes, but a full cross-item cycle
  through a not-yet-indexed third item is best-effort. Acceptable — those are
  inherently whole-set views.
- **Jira issues created by tests can't be auto-deleted** when the API token
  lacks the Delete Issues permission (returns 403); the e2e logs the keys for
  manual cleanup rather than failing.
- `summary` lists only `done` items by design (top-level done tasks, or done
  sub-tasks of a given parent) — an empty result for in-progress-only items is
  correct, not a bug.
