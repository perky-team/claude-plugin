# Design: `p-graph` — code knowledge graph plugin

**Date:** 2026-06-15
**Status:** Approved (brainstorming)
**Targets:** new plugin `plugins/p-graph` at `0.1.0`; new entry in `.claude-plugin/marketplace.json`. Monorepo tag bump per the repo's release rule (new plugin → minor at minimum on the monorepo tag).

---

## 1. Goal

Give Claude a queryable, structural map of a codebase — what symbols exist, where, and how they call/import/extend each other — so it answers "where is X defined", "what calls Y", "what breaks if I change Z", and "how does X reach Y" from a pre-built index instead of grepping and reading files. This is the perky.team analogue of the `codegraph` tool (colbymchenry/codegraph), rebuilt in the house style of `p-wiki`/`p-tasks`.

### 1.1 Why a plugin, and why not MCP

The reference `codegraph` is a mature tree-sitter + SQLite **MCP server**. perky.team plugins deliberately ship no MCP servers: `p-wiki` and `p-tasks` are dependency-light `.mjs` CLIs that skills invoke and that Claude follows via a `CLAUDE.md` rule. `p-graph` follows that pattern exactly:

- A `pgraph` CLI builds and queries the graph.
- Claude calls `pgraph <subcommand>` via Bash **instead of grep** for structural questions, steered by a shipped `CLAUDE.md` rule (a "prefer pgraph over grep" decision table — the same discipline the reference encodes, but pointed at the CLI rather than MCP tools).
- A `/p-graph:sync` skill refreshes the graph after code changes.

This keeps `p-graph` consistent with the marketplace, installable without configuring an MCP server, and fully local.

### 1.2 Non-goals (v1)

- **No MCP server.** Claude reaches the graph through the Bash CLI, never an MCP tool.
- **No automatic reindex hook.** Sync is the explicit `/p-graph:sync` skill (user decision: predictable over magic). A PostToolUse auto-reindex hook is a possible future addition, not v1.
- **No centralized / remote destination transport.** v1 ships exactly one destination (`local-sqlite`). The destination abstraction (§3) is built so a future shared-snapshot or server destination plugs in without touching the indexer or queries, but no `push`/`pull`/remote adapter is implemented now. (Industry models for that future layer: Sourcegraph SCIP upload, JetBrains Shared Indexes — see §11.)
- **No committing the index to git.** The index is a derived, always-rebuildable cache; `.pgraph/` is gitignored. Freshness comes from incremental sync keyed on the indexed commit SHA, not from a checked-in snapshot (a binary SQLite in git would churn every commit and cause unresolvable merge conflicts).
- **No semantic / type-resolved cross-language linking** (the reference's framework-aware routing, iOS/RN bridging). Call resolution is best-effort name+scope matching within a single language.

---

## 2. Languages and parsing

v1 covers **TypeScript/JavaScript** (incl. `.ts/.tsx/.js/.jsx/.mjs/.cjs`), **Go**, **C++** (`.cc/.cpp/.cxx/.h/.hpp`), and **Python**.

A language-agnostic engine is required (TS Compiler API would cover only TS/JS), so parsing uses **`web-tree-sitter` (WASM)** plus prebuilt `.wasm` grammars per language — pure JS, no native build, cross-platform on Windows.

- `tools/lib/grammars/*.wasm` — bundled grammars: `tsx`, `typescript`, `javascript`, `go`, `cpp`, `python`.
- `tools/lib/parse/index.mjs` — registry mapping file extension → grammar + extraction query.
- `tools/lib/parse/{ts,go,cpp,py}.mjs` — per-language tree-sitter tag queries that extract **definitions** (functions, methods, classes, structs, interfaces, types, enums, top-level vars) and **references** (calls, imports/includes, extends/implements).

C++ is explicitly **best-effort**: tree-sitter parses syntax, but there is no preprocessor expansion beyond capturing `#include` edges, and overload/template resolution is name-based only. Stated as a known limitation, not a bug.

---

## 3. Destination abstraction

Mirrors `p-wiki`'s destination architecture (`lib/destination.mjs` resolver + `lib/destinations/<name>.mjs` adapters):

- `lib/config.mjs` reads `destination` from `.pgraph/config.json` (default `local`), resolves repo root, reads `.pgraphignore`.
- `lib/destination.mjs` — resolver that loads and returns the configured adapter.
- `lib/destinations/local-sqlite.mjs` — the **only** v1 adapter, backed by `node:sqlite`.

**The indexer (`index/*`) and every query (`query/*`) talk only to the destination interface — never to `node:sqlite` directly.** That boundary is the seam that lets a future centralized destination drop in.

### 3.1 Destination interface

Write side (used by the indexer):

- `open()` — open/create the store, run migrations to `schema_version`.
- `upsertFile(path, hash, lang)` — record a file's content hash + language.
- `replaceFileSymbols(file, nodes, edges)` — atomically replace all nodes/edges owned by `file` (the unit of incremental update).
- `removeFile(path)` — drop a deleted file's nodes/edges.
- `getMeta(key)` / `setMeta(key, value)` — `schema_version`, `indexed_sha`, etc.
- `resolvePending()` — best-effort second pass that links edges whose `dst_name` now matches a known node.

Read side (used by queries):

- `search`, `node`, `callers`, `callees`, `impact`, `trace`, `files`, `status`.

A future remote/server destination implements the same interface. Graph traversal (`impact`, `trace`) is expressed in terms the local adapter satisfies with recursive SQL; pushing traversal into a remote backend is a v1.1 concern and deliberately not abstracted further now (YAGNI).

### 3.2 `node:sqlite` requirement

`node:sqlite` is built into Node ≥ 22.5 (experimental flag on 22.x, stable on 24+). `open()` detects an unavailable `node:sqlite` and exits 1 with a clear "Node ≥ 22.5 required for p-graph" message. No native dependency, no `node-gyp`.

---

## 4. Data model (local-sqlite schema)

- **nodes**: `id` (stable string: hash of `file` + `qname` + `kind`), `name`, `qname` (qualified, e.g. `pkg.Type.method`), `kind` (`function|method|class|struct|interface|type|enum|var|file`), `lang`, `file`, `start_line`, `end_line`, `signature`, `doc` (leading doc-comment, if any), `container_id` (enclosing symbol, nullable).
- **nodes_fts**: FTS5 over `name`, `qname`, `signature` for `search`.
- **edges**: `src_id`, `dst_id` (nullable when unresolved), `dst_name` (raw callee/type name, kept for unresolved edges so `callers`-by-name works and `resolvePending` can link later), `kind` (`call|import|include|extends|implements|reference`), `file`, `line`.
- **files**: `path`, `hash`, `lang`, `indexed_at`.
- **meta**: key/value — `schema_version`, `indexed_sha`, `created_at`.

**Call resolution** is best-effort by name and scope: same file → symbols imported into the file's module → globally unique name match. Ambiguous or external names stay unresolved (`dst_id` null, `dst_name` set).

`id` stability note: including `start_line` is deliberately avoided in `id` so that moving a symbol within a file does not orphan inbound edges; `id` is `hash(file + qname + kind)`. Two same-kind symbols with the same qualified name in one file (rare; e.g. C++ overloads) are disambiguated by appending an occurrence ordinal.

---

## 5. CLI surface

`tools/pgraph.mjs` routes subcommands. Read commands all accept `--json` (default output is compact human/agent-readable text); exit codes follow the repo convention (0 ok, 1 user/env error, 2 schema/conflict, 3 internal).

| Command | Purpose |
|---|---|
| `pgraph index [--full \| --changed]` | Build the graph. `--full` reparses everything; `--changed` (default) reparses only the delta (§6). |
| `pgraph status` | Schema version, indexed SHA, node/edge/file counts, and **drift** (files changed since the index). |
| `pgraph search <query> [--kind k] [--lang l]` | FTS symbol lookup → kind, location, signature. |
| `pgraph node <id\|qname>` | Full signature + source + doc + location for one symbol. |
| `pgraph callers <name>` | Call sites of a symbol. |
| `pgraph callees <name>` | What a symbol calls. |
| `pgraph impact <name>` | Transitive reverse dependencies (BFS over reversed `call`/`reference` edges). |
| `pgraph trace <from> <to>` | A call path between two symbols, if one exists. |
| `pgraph context <query>` | Composed overview: matched symbol(s) + signature + immediate callers/callees. |
| `pgraph explore <names…>` | Several symbols' source at once, grouped. |
| `pgraph files <path>` | Files under a path with per-file symbol counts. |

`search`/`node`/`callers`/`callees`/`impact`/`trace`/`context`/`files` are the surface Claude calls per the rule; `index` is driven by the skills.

---

## 6. Incremental sync

`pgraph index --changed` (what `/p-graph:sync` runs):

1. Read `indexed_sha` from `meta`.
2. Compute the changed set: `git diff --name-only <indexed_sha>..HEAD` ∪ dirty working-tree files (`git status --porcelain`), filtered to supported extensions and `.pgraphignore`.
3. For each changed file: reparse, `replaceFileSymbols(file, …)`. For each deleted file: `removeFile`.
4. `resolvePending()` — relink edges whose `dst_name` now resolves (a new file may define a previously-unresolved callee) and null out edges into removed symbols.
5. `setMeta('indexed_sha', HEAD)`.

If `indexed_sha` is missing (fresh `.pgraph`) or `--full` is passed, walk the whole tree instead. Falling back to a full walk is also correct when `git` is unavailable or the repo is not a git checkout — `index` works without git, just without the cheap delta.

This is the answer to "don't reindex everything on every pull": after `git pull`, sync touches only the pulled diff.

---

## 7. Skills

| Skill | Does |
|---|---|
| `init` | Create `.pgraph/config.json` (`destination: local`), add `.pgraph/` to `.gitignore`, write the `CLAUDE.md` rule from the template, then run the first `pgraph index --full`. |
| `sync` | Run `pgraph index --changed` (or `--full` on request); report counts and drift. |
| `help` | Cheat-sheet of `pgraph` commands and when to use each (mirrors `p-statusline`'s `help`). |

Queries themselves are **not** a skill — Claude runs the CLI directly, governed by the rule. This matches the reference's model (the agent calls the tools; there is no "query" wrapper).

---

## 8. Output format and the CLAUDE.md rule

- Default text output is compact and line-oriented (one symbol/edge per line: `kind qname  file:line  signature`), tuned for Claude to read cheaply. `--json` emits structured objects for any programmatic use.
- `skills/_shared/templates/p-graph-rule.template.md` — the rule installed into the target repo's `CLAUDE.md`. It contains:
  - A **decision table**: structural questions ("where is X", "what calls Y", "impact of Z", "trace X→Y") → `pgraph`; literal-text questions (string contents, comments, log messages) → grep/Read.
  - A freshness reminder: run `/p-graph:sync` before relying on the graph if code changed this session.
  - A note that the index lags writes until synced (no file watcher in v1).
- `skills/_shared/templates/pgraph-claude-md.template.md` — a short snippet the `init` skill merges into the target repo's `CLAUDE.md` documenting the available `pgraph` commands.

---

## 9. Plugin layout

```
plugins/p-graph/
  .claude-plugin/plugin.json          # name p-graph, version 0.1.0
  README.md
  skills/
    init/SKILL.md
    sync/SKILL.md
    help/SKILL.md
    _shared/templates/
      p-graph-rule.template.md
      pgraph-claude-md.template.md
  tools/
    pgraph.mjs                         # subcommand router
    lib/
      config.mjs                       # repo root, .pgraph paths, .pgraphignore, destination
      destination.mjs                  # resolver
      destinations/local-sqlite.mjs    # the one v1 adapter (node:sqlite)
      parse/
        index.mjs                      # extension → grammar + query registry
        ts.mjs  go.mjs  cpp.mjs  py.mjs
      index/
        build.mjs                      # full + incremental
        resolve.mjs                    # best-effort name/scope call resolution
      query/
        search.mjs node.mjs callers.mjs callees.mjs
        impact.mjs trace.mjs context.mjs explore.mjs files.mjs status.mjs
      grammars/*.wasm
    __tests__/                         # vitest
  docs/superpowers/specs/              # this file
  docs/superpowers/plans/              # implementation plan (next step)
```

Module boundaries: `parse/` only turns file text into `{nodes, edges}`; `destinations/` only persists and retrieves; `query/` only reads through the destination; `index/` orchestrates. Each is unit-testable in isolation.

---

## 10. Testing (TDD)

- **parse/** per language: a fixture source file → expected nodes (kinds, qnames, lines) and edges (calls, imports/includes, extends). One fixture per language (TS/JS, Go, C++, Python), covering at least: a function, a type/class with a method, an import/include, and a call between two symbols.
- **destinations/local-sqlite**: `replaceFileSymbols` is idempotent (re-indexing a file produces the same rows); `removeFile` drops only that file's rows; `resolvePending` links a previously-unresolved edge once its target appears; FTS `search` matches by name and qname.
- **index/build**: `--full` on a fixture repo populates expected counts; `--changed` after editing one file updates only that file's symbols and fixes a dangling edge; a deleted file's symbols disappear; works with `git` absent (full-walk fallback).
- **CLI e2e** (`pgraph` subprocess over a multi-language fixture repo): `search`, `node`, `callers`, `callees`, `impact`, `trace`, `files`, `status` produce expected text and `--json`; `status` reports drift after an out-of-band edit; unknown command / missing arg → exit 1.
- **Node version guard**: `open()` on a simulated missing `node:sqlite` → exit 1 with the required-version message.

---

## 11. Future work (explicitly out of v1)

- **Centralized destination** (the "second backend"): a destination that stores SHA-keyed index snapshots in a shared location, with `pgraph push` (export `graph-<sha>.db.zst`, upload) and `pgraph pull` (download for HEAD's SHA, or nearest ancestor + incremental top-up). First adapter likely a shared FS/UNC path or an HTTP(S) base URL. Industry precedent: [Sourcegraph SCIP upload](https://sourcegraph.com/docs/admin/how-to/lsif-scip-migration), [JetBrains Shared Indexes](https://dev.to/coder/faster-jetbrains-ides-with-shared-indexes-10n1). The §3 interface is built to accept this without indexer/query changes.
- **PostToolUse auto-reindex hook** for hands-off freshness.
- **More languages** via additional grammars.
- **Richer C++ semantics** (preprocessor-aware, overload resolution).

---

## 12. Versioning

New plugin at `0.1.0`. New `marketplace.json` entry. On release, the monorepo tag bumps per the repo's tagging rule (a brand-new plugin is an additive change to the marketplace → at least a minor bump on the monorepo tag).
