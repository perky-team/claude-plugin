# p-observe — realtime observability for perky.team plugins

**Date:** 2026-07-17
**Status:** Design (approved to plan)

## 1. Problem

The repo ships four plugins that each accumulate state and do work at runtime —
**p-shed** (cron scheduler), **p-tasks** (task tracker), **p-graph** (code graph),
**p-wiki** (knowledge wiki) — but there is no way to *see* what is happening inside
them. The primary pain is **background automation**: while the user is away, p-shed
launches headless `claude -p` jobs that in turn mutate tasks, reindex the graph, and
compile wiki pages. Today that activity is invisible unless you manually diff files
after the fact.

We want a **realtime, human-readable view** of what these plugins are doing — a
`tail -f`-style stream plus a live status view — so "what happened while I was away"
and "what is running right now" are answerable at a glance.

### What is capturable, honestly

The observer is fundamentally **live**: for three of the four plugins it reconstructs
events by watching state files *while it is running*. That splits the "away" case in two:

- **p-shed** persists its own log, so its job history survives regardless — every
  overnight run is recoverable after the fact.
- **p-tasks / p-graph / p-wiki** have no event log of their own. If the observer was
  *running* during the night (see the `capture` mode, §8/§10), their full transition
  timeline is captured too. If it was *not*, only the **end state** is recoverable —
  you see that `TASK-12` is now `done`, not that it went `todo → in_progress → done` at
  03:00.

So the marquee promise holds in two tiers: (a) *live or with a running capturer* → full
cross-plugin timeline; (b) *cold start after the fact* → p-shed's complete log + current
state of the others. This is an accepted, explicit limitation of zero-touch observation,
not an oversight.

## 2. Goals / non-goals

**Goals**
- Realtime stream of human-readable events across the 4 plugins, in one place.
- Live status ("what's running / what failed / what's due next").
- Work against **already-installed** versions of the 4 plugins — no coupling, no
  version lockstep.
- Ship as a normal marketplace plugin (`p-observe`) with a bundled `pobserve` CLI.

**Non-goals**
- Observing **p-flow** (no state dir, no CLI, model-driven — out of scope by decision).
- Per-symbol graph diffs or line-level wiki prose diffs (aggregate/file-level is enough).
- Being a general log aggregator for arbitrary tools.
- Persisting p-observe's own event journal **by default**. The default (`watch`/`tui`) is
  in-memory only; an on-disk journal is opt-in via `capture` mode / `--journal` for users
  who need the full offline timeline (see §8/§10).

## 3. Scope & core decision: zero-touch observation

**p-observe is a pure consumer.** It never requires changes to the observed plugins.
It derives events from three cheap sources: tailing p-shed's existing JSONL log,
watching state files with `fs.watch` (+ re-parsing/diffing on change), and shelling out
to `pgraph status --json` when the graph db changes.

This "zero-touch" choice (vs. instrumenting each plugin to emit events) was made after a
per-plugin code analysis of where each plugin actually writes state:

| Plugin | Single write choke point? | Instrumentation value over zero-touch |
|---|---|---|
| p-shed | yes — `tools/lib/tick.mjs` | **high** (scheduler decisions not persisted today) |
| p-tasks | yes — `destinations/fs.mjs writeDoc()` + Jira path | moderate (only the Jira-primary case) |
| p-graph | `freshness.mjs doReindex()` | ~none — reindex writes `graph.db`, so mtime-watch already catches the same events |
| p-wiki | **no** — `compile` writes pages via the model's Write/Edit, not the CLI | negative — CLI instrumentation is leaky; file-watch is required regardless |

The only place instrumentation clearly pays off is **p-shed**, and even there it is
framed as improving p-shed's *own* log — not as coupling it to p-observe (see §7).
p-graph instrumentation would duplicate zero-touch; p-wiki cannot be instrumented
cleanly (its main mutation bypasses the CLI); p-tasks/Jira is deferred to the backlog.

### Auto-detection & config
On start, p-observe observes whichever plugins leave traces in the repo:
`.pshed/`, `docs/tasks/tasks.yml`, `.pgraph/graph.db`, `docs/wiki/`. Missing plugins are
silently skipped. Roots default to the git toplevel / cwd.

An optional `.pobserve.json` overrides defaults:

```jsonc
{
  "roots": { "pshed": ".pshed", "ptasks": "docs/tasks/tasks.yml",
             "pgraph": ".pgraph/graph.db", "wiki": "docs/wiki" },
  "pgraphCli": "…/plugins/p-graph/tools/pgraph.mjs",  // for graph counts; see §6
  "nodeBin": "node",                                   // used to invoke pgraphCli
  "bufferSize": 500,                                   // ring-buffer capacity
  "journal": false,                                    // opt-in on-disk journal (§10)
  "journalRetentionDays": 7                            // day-rotated journal retention
}
```

`.pobserve.json` is written/updated by `/p-observe:init`; all fields are optional and
have the defaults shown.

## 4. Architecture — four layers

```
adapters (per-plugin)   →   normalizer   →   event bus            →   renderers
  watch / tail / stat        raw → Event      in-mem ring buffer        ├ stream (pobserve watch)
                                              + live pub/sub            └ TUI   (pobserve tui)
```

- **Adapters** know *how* to get a signal out of one plugin. They are the only
  plugin-specific code.
- **Normalizer** maps raw signals to the single `Event` shape (§5).
- **Event bus** is an in-memory ring buffer (capacity `bufferSize`, default 500) plus a
  live subscriber list. Persistence is one **optional subscriber** — the journal sink
  (§10) — off by default.
- **Renderers** are pure consumers of the same event stream. The TUI is *not* a separate
  program — it is a second subscriber. This keeps stream and TUI behavior identical and
  independently testable. The journal sink and a headless `capture` run are just further
  subscribers, so persistence adds no special path.

## 5. Normalized event model

```jsonc
{
  "ts": 1752754992000,          // epoch ms
  "plugin": "p-shed",           // p-shed | p-tasks | p-graph | p-wiki
  "kind": "job.finished",       // machine label, namespaced per plugin
  "entity": "daily-index",      // job id / task id / page path / "-"
  "severity": "ok",             // ok | info | warn | error
  "summary": "exit 0 (42s)",    // human-readable line for the stream
  "data": { "exit": 0, "durationMs": 42000 }  // raw payload for panels/filters
}
```

Everything downstream — the stream line, the master-detail panes, and the filters
(`--plugin`, `--entity`/`--job`, `--severity`) — is a projection or predicate over this
one shape.

## 6. Per-plugin adapters

| Plugin | Mechanism | Emitted kinds | Known blind zones |
|---|---|---|---|
| **p-shed** | tail `.pshed/logs/*.jsonl`; watch `.pshed/run/*.pid`; parse `.pshed/jobs.yml` (cron → next-due); read `.pshed/state/*.json` | `job.launched` (from pidfile appearing), `job.finished` (exit/timeout/duration from log), `job.baselined`/`job.skipped`/`job.notdue` (once p-shed enrichment lands, §7) | without §7: skipped/not-due/baselined decisions aren't persisted; catch-up runs *are* logged (as completions) but unlabeled |
| **p-tasks** | watch + diff `docs/tasks/tasks.yml` against last snapshot | `task.status` (id: old→new), `task.added`, `task.removed` | Jira-primary invisible (no local file); only the FS destination is watchable |
| **p-graph** | watch mtime of `.pgraph/graph.db`; when `pgraphCli` is configured, run `pgraph status --json` for counts | `index.refresh` (Δnodes/Δedges/Δfiles when counts available, else "db changed"), `drift.warn` | no per-symbol detail (binary sqlite); without `pgraphCli`, coarse mtime-only events |
| **p-wiki** | watch `docs/wiki/**`; parse frontmatter of changed files | `page.compiled` (`compiled:false→true`), `page.edited`, `page.removed`, `raw.ingested`, `wiki.conflict` (frontmatter `conflict-since` appears/clears), `wiki.reindex` (`index.json` regenerated) | Confluence-primary invisible (no local files); prose-level diff only via optional `git diff` |

### p-graph CLI resolution (soft dependency)
`pgraph status --json` returns `{ schema_version, nodes, edges, files, indexed_sha, fts,
drift }` — enough for deltas and drift. p-observe **must not** read `graph.db` directly:
that would require `node:sqlite` (Node ≥ 22.5, breaking §11) and couple p-observe to
p-graph's schema (already at v3). So the graph adapter shells out to the real `pgraph`.

**There is no automatic cross-plugin path resolution.** A skill has no handle to *another*
plugin's `${CLAUDE_PLUGIN_ROOT}` — this repo's own p-flow bridge states it explicitly
(`plugins/p-flow/skills/_shared/pgraph-bridge.md`: "there is no path to p-graph's own
`${CLAUDE_PLUGIN_ROOT}` from inside p-flow"). So `pgraphCli` is resolved as:

1. **Explicit config** — `.pobserve.json#pgraphCli`, the authoritative source.
2. **Best-effort probe by `/p-observe:init`** — glob the known install locations
   (`~/.claude/plugins/cache/*/p-graph/tools/pgraph.mjs`,
   `~/.claude/plugins/marketplaces/*/plugins/p-graph/tools/pgraph.mjs`), and if exactly one
   matches, record it and ask the user to confirm. Zero or multiple matches → prompt the
   user to paste the path. Local `--plugin-dir` dev installs have no cache entry and must be
   configured by hand. This probe is a convenience, not a guarantee.
3. **Unset / call fails** → the adapter **degrades gracefully** to mtime-only
   `index.refresh` events (no counts) plus a one-time warning. p-observe never crashes and
   never opens the db itself.

Counts are therefore an *opt-in enhancement*; the graph adapter's baseline ("db changed,
reindexed") works with no configuration at all.

### Severity assignment
Adapters set `severity` per kind: `error` for `job.finished` with non-zero exit or
timeout, and for a failed `pgraph` call; `warn` for `drift.warn` and `wiki.conflict`;
`ok` for successful job completions; `info` for everything else (launches, task/page
transitions, reindexes).

### Conflict signal (p-wiki)
`conflict-since` is a first-class frontmatter field (ISO date) p-wiki's `compile` sets
when a source contradicts a page and `reconcile` clears. The adapter keys `wiki.conflict`
off this field's presence in parsed frontmatter — a reliable, structured signal — rather
than scanning body text for callout shapes.

### p-wiki backend (Confluence-primary blind zone)
p-wiki, like p-tasks, has a dual backend: FS (`docs/wiki/`, default) or **Confluence
Cloud**, chosen per-repo in `docs/wiki/.pwiki.json#primary`. A Confluence-primary wiki
writes **no local page files** (`destinations/confluence.mjs` has no file writes; pages are
virtual `confluence://…` paths) and stores `conflict-since` as a Confluence page property,
not in local frontmatter. So `page.*` and `wiki.conflict` are invisible for a
Confluence-primary wiki — exactly the symmetric case to p-tasks/Jira. `/p-observe:init`
reads `.pwiki.json#primary`; if it is Confluence (and no FS mirror exists), init **warns
and skips** the wiki adapter instead of watching an empty `docs/wiki/pages/` tree. An FS
mirror of a Confluence-primary wiki, if configured, *is* watchable and is used instead.

### Watcher strategy
`fs.watch` is unreliable in detail (recursive mode historically unsupported on Linux;
editors do atomic rename-then-replace). Adapters therefore treat a watch event only as a
*hint*: they debounce (~150 ms), then re-`stat`/re-read/re-parse the target and diff
against their own last snapshot to decide what actually changed. Correctness never
depends on the event's `filename`/`eventType`. Where recursive watching is unavailable,
adapters fall back to per-directory watchers or a stat-poll loop.

**Torn reads.** The observed plugins write non-atomically — p-tasks' `writeDoc` is a plain
`writeFileSync` (`destinations/fs.mjs`) and `loadTasksDoc` *throws* on malformed YAML
(`yaml.mjs`, no catch). A re-read racing a mid-flight write can therefore hit a truncated
file. Every parse-on-change adapter must **catch the parse error, keep its previous
snapshot as the diff baseline, and retry on the next debounce tick** — never crash, never
advance the baseline on a failed parse. (This mirrors p-shed's own tolerance of
corrupt/truncated state files, `io.mjs:47-48`.)

**graph.db under WAL.** p-graph opens the db in WAL mode
(`destinations/local-sqlite.mjs` `PRAGMA journal_mode = WAL`), so writes land in
`graph.db-wal` and the main file's mtime advances only on checkpoint. In the normal path
the short-lived `pgraph` CLI checkpoints on `store.close()` at process exit, so mtime
moves — but a `pgraph` killed mid-run (e.g. by p-shed's job timeout) can leave the WAL
unmerged and the mtime stale. The graph adapter therefore watches `graph.db`,
`graph.db-wal`, **and** `graph.db-shm` mtimes, treating a change to any as a refresh hint.

## 7. p-shed log enrichment (separate, self-standing change)

`tools/lib/tick.mjs` computes exactly one of four per-job actions each tick —
`launched | skipped | not-due | baselined` (`tick.mjs:50,55,58,66`) — and appends only
`launched` **completions** to `.pshed/logs/*.jsonl` (`tick.mjs:64`). So the `skipped`
(duplicate-guard: previous run still alive), `not-due`, and `baselined` (first-seen)
decisions are never persisted. Note a **catch-up** run (a due tick recovered via
`isDue()`'s lookback in `cron.mjs`) already resolves to `launched` and *is* logged today —
it just isn't labeled as a catch-up.

**Change:** (1) append a record for the non-launched actions too, e.g.
`{ ts, job, action: "skipped", reason: "prev-run-alive" }`; (2) add a `catchup: true` flag
to a `launched` completion record when the run was a recovered missed tick. This is a
**backward-compatible enrichment of p-shed's own log** — p-shed gains nothing about
p-observe and stays fully decoupled; a scheduler that records *why it skipped* (and that a
run was a catch-up) is simply a better scheduler. p-observe reads these records like any
other, and `job.baselined`/`job.skipped`/`job.notdue` map 1:1 to the new records.

This ships as its **own small p-shed release**, independent of p-observe. p-observe
tolerates both the old and new log shapes (records are self-describing; unknown actions
are surfaced generically). p-observe never *requires* the enrichment — it just gets
richer p-shed events when the installed p-shed has it.

## 8. CLI surface & skills

**CLI (`pobserve`):**
- `pobserve watch [--plugin=… --entity=… --severity=…] [--journal]` — flat merged stream
  (phase 1). In-memory by default; `--journal` also appends to the on-disk journal.
- `pobserve status [--json]` — one-shot snapshot (counters + running/failed).
- `pobserve capture` — headless, always-on mode: runs the bus + the on-disk journal sink
  with no renderer. Intended to be kept running (login item / tmux) so the full
  cross-plugin timeline — including overnight cron activity in p-tasks/p-graph/p-wiki — is
  persisted for later viewing (§10).
- `pobserve tui` — the k9s-style TUI (phase 2).

**Skills:**
- `/p-observe:init` — auto-detect present plugins; optionally scaffold `.pobserve.json`.
- `/p-observe:watch` — launch the live line stream (`pobserve watch`).
- `/p-observe:tui` — launch the k9s-style TUI (`pobserve tui`).
- `/p-observe:help` — cheat-sheet.

## 9. UI — k9s / lazygit style TUI

Two zones behave differently by design:

- **Stream zone** scales on its own — one chronological line per event, colored/labeled
  by plugin, filterable. Readable at any event volume.
- **Status zone** does not scale as fixed per-entity boxes, so it uses rollups + "only
  the interesting" rows (running now / failed last), with the full list one keypress away.

**Tabs (like k9s/lazygit):**
- **Overview** (default) — rollup counters for all 4 plugins + the **merged** stream, so
  causal bursts (p-shed job → p-graph reindex → p-tasks update within seconds) are visible
  as one sequence rather than split across tabs.
- **Per-plugin tab** — full screen for that plugin. **Master-detail** where it fits:
  - p-shed: jobs list (left, sorted failed/running first, `j/k`, `/` filter) → selected
    job's state + next-due + its filtered log lines (right).
  - p-tasks: task list → task detail + status history.
  - p-wiki: page list → frontmatter + recent changes.
  - p-graph: single-entity, so no list — counters + reindex history (optional: files list
    with drift highlight).
- **Activity badges** on tab headers (unread count / ● pulse) so background events on
  other tabs are not missed.

**Keys:** `Tab`/digits switch tabs; `j/k` move selection; `/` filter; `f` toggle follow;
`q` quit. Rendered with raw ANSI — **no external TUI library** (see §11).

## 10. Backfill on start & the optional journal

So the Overview is not empty when launched, `watch`/`tui` backfill the ring buffer before
switching to live watching. The backfill source depends on whether a journal exists:

1. **Journal present** (a `capture` run was up, or a prior `--journal` session) — replay
   the tail of `.pobserve/events.jsonl`. This yields the **full** recent timeline,
   including the p-tasks/p-graph/p-wiki transitions captured while p-observe ran.
2. **No journal** (cold start) — degraded backfill: read today's `.pshed/logs/*.jsonl`
   (authoritative for job runs) and snapshot the current state of each present adapter
   (tasks.yml, `pgraph status` if available, wiki counts). This shows every p-shed run
   plus the *end state* of the others, but not their intermediate transitions (§1).

In both cases live state snapshots reconcile against the current filesystem so the status
zone is accurate even if the journal is stale.

**The journal sink.** When enabled (`capture`, or `watch --journal`, or `"journal": true`),
a subscriber appends every `Event` to `.pobserve/events.jsonl`, day-rotated with a
`journalRetentionDays` cap (default 7, same shape as p-shed's `logs.mjs` rotation).
`.pobserve/` is gitignored by `/p-observe:init`. Off by default: the plain `watch`/`tui`
path writes nothing to disk.

**Ring-buffer truncation.** The in-memory buffer holds only the last `bufferSize` (500)
events, so a burst — e.g. a large `/p-wiki:compile` run emitting many `page.compiled`
events — can evict older events before a viewer scrolls to them. This is a display-only
limit; the journal (when enabled) is the durable record and is not bounded by `bufferSize`.

**`job.launched` race.** p-observe synthesizes `job.launched` from a pidfile appearing
(`.pshed/run/<id>.pid`), which `tick.mjs` removes immediately after the run completes. A
job that finishes faster than the ~150 ms debounce can have its create+unlink coalesced
and miss the launch event; the run is never lost, though — its `job.finished` still arrives
from the log, and a `finished` with no preceding `launched` is rendered as an implicit
launch.

## 11. Constraints

- **Node ≥ 18**, **zero external dependencies** (`fs.watch`, `child_process`, ANSI escape
  codes only) → nothing to vendor; simpler to package than the other plugins. p-observe
  **never opens `graph.db` itself** (that would force Node ≥ 22.5 and schema coupling —
  §6); it only ever shells out to `pgraph status`, invoked via `nodeBin`. p-graph's own
  Node ≥ 22.5 requirement is pgraph's concern, not p-observe's.
- `fs.watch` reliability handled per §6 (debounce + re-stat, per-dir fallback).
- Cross-platform: primary dev/target is Windows; adapters must not assume POSIX-only
  behavior.

## 12. Testing

- **Adapters & normalizer** — unit tests over temp dirs: write a synthetic
  `jobs.yml`/`tasks.yml`/`*.jsonl`, poke the adapter, assert the emitted `Event`s. Same
  style as the existing p-shed/p-tasks suites.
- **Torn-read tolerance** — write a truncated/half-written `tasks.yml`, fire the adapter,
  assert it neither throws nor advances its diff baseline, then write valid content and
  assert the correct diff emits on the next tick.
- **p-graph degrade** — with no `pgraphCli`, assert the adapter emits mtime-only
  `index.refresh` (no counts) and does not open the db; with a stubbed `pgraph status`,
  assert count deltas.
- **Renderers** — snapshot the stream lines for a fixed event sequence.
- **TUI** — modeled as pure `state → string[]` layout functions (tab bar, overview,
  master-detail), snapshot-tested without a real terminal. Key handling is a pure
  reducer `(state, key) → state`.
- **p-shed enrichment** — extend p-shed's own `tick`/`logs` tests to assert the new
  action records; assert p-observe tolerates both old and new log shapes.
- **Journal & backfill** — round-trip test: feed events → journal sink → replay backfill,
  assert equality; and a cold-start test asserting the degraded backfill (p-shed log +
  end-state snapshots) when no journal is present.

## 13. Phasing & releases

- **Phase 1 — event core + CLI.** Event model, adapters, normalizer, ring buffer, the
  optional journal sink, and `pobserve watch` / `pobserve status` / `pobserve capture`.
  Delivers value immediately and is fully testable. (The journal sink is just a
  subscriber, so `capture` is nearly free once the bus exists.)
- **Phase 2 — TUI.** k9s-style tabs + master-detail on top of the same event model.
- **p-shed enrichment** — its own small p-shed release; can land in parallel, independent
  of the p-observe phases.

Each phase becomes its own implementation plan; this spec is shared across them.

## 14. Backlog / deferred

- **p-tasks Jira-primary visibility** — emit from both destinations so a Jira-primary
  tracker is observable. Only worth doing if a Jira-primary tracker is actually run under
  observation.
- Optional `git diff` enrichment for wiki prose-level change summaries.
- **Offline timeline reconstruction from git** — for a cold start with no journal, mine
  `git log -p` on `docs/tasks/tasks.yml` / `docs/wiki/**` to approximate the intermediate
  transitions that happened while p-observe was down (only where cron jobs commit their
  work; granularity is per-commit, not per-transition).
