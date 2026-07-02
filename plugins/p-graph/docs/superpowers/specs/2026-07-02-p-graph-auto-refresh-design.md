# p-graph auto-refresh on query — design

**Date:** 2026-07-02
**Plugin:** p-graph
**Status:** approved

## Problem

`.pgraph/graph.db` goes stale as code changes. Today the query commands
(`search`, `node`, `callers`, `callees`, `impact`, `trace`, `context`, `explore`,
`files`) answer from the DB as-is; freshness relies on a human or the model
remembering to run `/p-graph:sync` (which runs `pgraph index --changed`). The
installed rule even states "the graph does not auto-update". A stale graph can
answer confidently wrong, which is worse than grep.

Incremental reindex already exists and is cheap: `index --changed` diffs git
(committed diff since the last indexed commit + dirty working tree) and reparses
only the changed files.

## Goal

Make freshness a property of the query tool, enforced at query time — no hook, no
background watcher. Before answering any structural query, `pgraph` refreshes the
graph if it has drifted. When the graph is already fresh, the query path stays as
fast as today.

## Design overview

A **freshness gate** runs before every query command. It computes git-based drift
(the same computation `status` uses), and if the graph has drifted and
auto-refresh is enabled, it runs the incremental reindex under an exclusive lock,
then answers from the now-fresh graph. `index` and `status` keep their current
behaviour — `status` reports drift but never refreshes, and `index` is the refresh
itself.

### Concurrency mechanism (decided)

The reindex is guarded by an **exclusive lock file** under `.pgraph/`, and the DB
is written **in place** relying on SQLite's atomic WAL-transaction commit — *not*
a temp-file→rename swap.

Rationale (this deviates from the original brief's "temp file → rename" wording,
by explicit agreement):

- **Windows correctness.** `fs.rename` over a file another process has open throws
  `EPERM`/`EBUSY` on Windows (`MoveFileEx` cannot replace a file with open
  handles; SQLite does not open with `FILE_SHARE_DELETE`). Query processes hold
  `graph.db` open for reading, so a rename swap would routinely fail — including
  in the very concurrency test this feature must pass. p-graph runs on Windows.
- **Performance.** temp→rename of the whole DB means copying the entire
  `graph.db` (potentially hundreds of MB) on every drifted query, just to reparse
  one file — defeating the point of an incremental reindex.
- **Atomicity is already guaranteed.** A WAL-transaction commit is atomic and
  crash-safe. Readers on a WAL DB always see a consistent snapshot; there are no
  torn reads. The exclusive lock file serializes reindexers so two processes never
  write concurrently. Together this satisfies the intent: `graph.db` is never
  corrupted.

## Components

### 1. Freshness gate — `tools/lib/freshness.mjs`

`ensureFresh(ctx)` is called from `runCommand` for query commands only. Query
commands: `search`, `node`, `callers`, `callees`, `impact`, `trace`, `context`,
`explore`, `files`. Not `index`, not `status`.

Logic:

1. `change = gitChangedFiles(root, store.getMeta('indexed_sha'))`;
   `drift = change ? change.modified.length + change.deleted.length : null`
   (`null` means git is unavailable / not a git checkout).
2. `autorefresh = process.env.PGRAPH_AUTOREFRESH !== '0' && !opts['stale-ok']`.
3. **drift === 0** → return immediately. Overhead is a single git invocation; no
   lock, no DB write.
4. **autorefresh disabled** (opt-out) → if `drift > 0`, emit the staleness banner;
   if git is unavailable, emit the unknown-drift banner. Answer from the current
   graph.
5. **autorefresh enabled, `drift > 0`** → refresh under the lock (below), then
   answer from the fresh graph.
6. **git unavailable** (not a git checkout) with an existing graph → graceful
   degrade: emit the unknown-drift banner, answer as-is. (A full index as fallback
   is *not* run automatically — it is potentially too expensive in a large non-git
   tree. Bootstrapping an empty graph remains the job of `init` / the first
   `index`.)

### 2. Reindex lock — `tools/lib/index/lock.mjs`

`withReindexLock(pgraphDir, { timeoutMs, staleMs }, fn)`:

- **Acquire:** `fs.openSync('.pgraph/reindex.lock', 'wx')` (exclusive create).
  Write `pid` + timestamp, close the fd.
- **Contended (`EEXIST`):** poll every ~50 ms up to `timeoutMs` (~5 s). A lock
  older than `staleMs` (~30 s — the holder likely died) is stolen (unlink +
  retry).
- **On acquire, re-check drift:** another process may have refreshed while we
  waited. If drift is now 0, release and let the caller query the fresh graph — we
  do **not** reindex again (this is the "waits, then reads fresh" requirement).
- **Reindex:** emit `p-graph: refreshing N changed files…` to stderr, then
  `indexChanged({ root, store, ignorePatterns, changedFiles: () => change, onError })`
  in place on the already-open WAL store.
- **On full success (no parse errors):** advance `indexed_sha` to HEAD (as `index`
  does) so committed changes stop counting as drift and repeat queries stay cheap.
- **On parse error(s):** do **not** advance `indexed_sha`; emit the staleness
  banner (graceful degrade — the changed file that failed keeps being flagged).
- **Timeout waiting for the lock, or any thrown error:** answer from the current
  graph + staleness banner.
- **Release:** `unlink` the lock file in a `finally`.

### 3. Banners (stderr)

stdout stays clean — only the query result / JSON — so callers that parse output
are unaffected. All notes and banners go to stderr.

- Known drift (exact, per requirement):
  `⚠ p-graph STALE: N files changed since index; results may be wrong. Run /p-graph:sync`
- Git unavailable (drift unknown):
  `⚠ p-graph STALE: cannot verify freshness (not a git checkout); results may be wrong. Run /p-graph:sync`

### 4. CLI wiring — `tools/pgraph.mjs`

- Parse `--stale-ok` (already handled generically by `parseArgs` as a boolean).
- Read `PGRAPH_AUTOREFRESH` from env.
- Add `warn(msg)` → `process.stderr.write(msg + '\n')`; pass it plus `pgraphDir`
  into the command context.

## Data flow

```
query command
  └─ runCommand
       └─ ensureFresh(ctx)              [query commands only]
            ├─ gitChangedFiles → drift
            ├─ drift 0            → return (fast path)
            ├─ opt-out / no-git   → banner, return
            └─ drift > 0 + auto   → withReindexLock:
                                       acquire (wait/steal-stale)
                                       re-check drift → maybe skip
                                       warn "refreshing…"
                                       indexChanged in place (WAL commit)
                                       advance indexed_sha on full success
                                       release lock
       └─ execute the query against the (now-fresh) store
```

## Error handling / graceful degradation

A query must always return an answer. Every refresh failure path (lock timeout,
non-git repo, read-only `.pgraph`, a changed file that fails to parse, any
exception) falls back to answering from the existing graph and printing the
staleness banner. The refresh is best-effort; the query is not.

## Testing

Vitest, alongside the existing suite:

- **Auto-refresh (CLI, real git repo):** init a git repo in a temp dir, commit,
  `index --full`, edit a source file, run `callers X` with **no** manual sync →
  the result reflects the change (verified against a full reindex).
- **drift 0 fast path:** no `refreshing…` note on stderr; result matches.
- **Opt-out:** `--stale-ok` and `PGRAPH_AUTOREFRESH=0` both skip the refresh and
  emit the staleness banner when drift > 0.
- **Lock / concurrency:** launch two `callers` processes in parallel right after a
  change; `graph.db` is not corrupted and both return the correct answer.
- **Graceful degradation:** non-git repo and read-only `.pgraph` → the query still
  answers, with the banner.
- **`status` unchanged:** still reports drift; does not refresh.
- **Lock unit test:** acquire, contended wait, stale-lock steal.
- All existing tests continue to pass.

## Docs / rule updates

Behaviour is changing, so the installed guidance must change too:

- `skills/_shared/templates/p-graph-rule.template.md`: remove "the graph does not
  auto-update"; state that structural queries auto-refresh the graph before
  answering, so manual sync is normally unnecessary; document
  `--stale-ok` / `PGRAPH_AUTOREFRESH=0`; note `/p-graph:sync` remains for an
  explicit full rebuild (`index --full`) and for warming the graph after a pull.
- `skills/_shared/templates/pgraph-claude-md.template.md`: match.
- `README.md`: match (freshness is automatic day-to-day; sync is for explicit /
  full rebuilds).
- `skills/sync/SKILL.md`: reframe sync as explicit/full rebuild + warm-after-pull,
  not the day-to-day freshness mechanism.

## Release hygiene

Bump `plugins/p-graph/.claude-plugin/plugin.json` version `0.3.1 → 0.4.0` (minor:
backwards-compatible new behaviour + new `--stale-ok` flag). Do **not** tag or
publish — the maintainer releases.

## Out of scope (YAGNI)

- No content-hash skip optimization (advancing `indexed_sha` already prevents
  rework on committed changes; actively-edited dirty files genuinely need
  reparsing).
- No new config keys or flags beyond `--stale-ok`.
- No automatic full-index fallback for auto-refresh in a large non-git tree.
