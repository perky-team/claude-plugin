# p-graph

A Claude Code plugin that indexes any git repo into a local SQLite code knowledge graph and answers structural questions — where a symbol is defined, what calls it, what breaks if it changes, how one symbol reaches another — from the index instead of grepping. Fully local, no MCP server.

Distributed via the [`perky.team`](../../) marketplace (see the repo root for the marketplace catalog).

## Requirements

**Node ≥ 22.5** is required. `pgraph` uses the built-in `node:sqlite` module introduced in Node 22.5 — no npm install, no native addon.

## Install

```text
/plugin marketplace add perky-team/claude-plugin
/plugin install p-graph@perky.team
```

The marketplace.json sits at the repo root, not inside this plugin's folder — so the `add` URL points at the repo, not at this subdirectory.

From a non-GitHub git host:

```text
/plugin marketplace add https://gitlab.com/perky-team/claude-plugin.git
/plugin install p-graph@perky.team
```

## Local development

Load this plugin standalone without going through the marketplace:

```bash
claude --plugin-dir C:/path/to/x/plugins/p-graph
```

After edits, run `/reload-plugins` inside Claude Code to pick them up without restarting.

## Supported languages

| Language | Extensions |
|---|---|
| TypeScript / JavaScript | `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` |
| Go | `.go` |
| C++ | `.cpp` `.cc` `.cxx` `.h` `.hpp` |
| Python | `.py` |

C++ support is best-effort: no preprocessor expansion beyond `#include` tracking; symbol resolution is name-based and may miss macro-generated names.

## Skills

| Skill | What it does |
|---|---|
| `/p-graph:init` | Creates `.pgraph/`, gitignores it, installs a rule at `.claude/rules/p-graph.md`, and runs the first full index. |
| `/p-graph:sync` | Refreshes the graph after code changes — incremental by default (`--changed`), full rebuild on request (`--full`). |
| `/p-graph:help` | Prints the pgraph command cheat-sheet. |

## Commands

All read commands (`search`, `node`, `callers`, `callees`, `impact`, `trace`, `context`, `explore`, `files`, `status`) accept `--json` for machine-readable output.

```text
node "${CLAUDE_PLUGIN_ROOT}/tools/pgraph.mjs" <command> [args]
```

| Command | What it does |
|---|---|
| `search <q>` | Find a symbol by name or qualified name. |
| `node <id\|qname>` | One symbol's kind, location, and signature. |
| `callers <name>` | Everything that calls the named symbol. |
| `callees <name>` | Everything the named symbol calls. |
| `impact <name>` | Transitive callers — everything that breaks if the symbol changes. |
| `trace <from> <to>` | A call path between two symbols. |
| `context <q>` | A symbol plus its immediate callers and callees. |
| `explore <names…>` | Several symbols at once, grouped in a single capped response. |
| `files <path>` | Files under a path with their symbol counts. |
| `index [--full\|--changed]` | Build or rebuild the graph. `--changed` (default) reparses only files modified since the last indexed commit; `--full` rebuilds from scratch. |
| `status` | Node, edge, and file counts; drift since last index. |

Refresh with `/p-graph:sync`. Prefer these commands over grep for structural questions — a grep can find a symbol name in a string literal; the graph tells you what actually calls it at runtime.

## How it works

`pgraph` uses [web-tree-sitter](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web) (vendored WASM grammars, no network required) to parse every source file into an AST, then extracts:

- **Symbols** — functions, methods, classes, structs, interfaces, type aliases, enums, and arrow-function variables/fields.
- **Edges** — call references (including `new` and method calls), `import` statements, and C/C++ `#include` directives.

### Name resolution

Each symbol carries a bare `name` (used for search/UX) and a qualified `qname`. Call edges are resolved conservatively: an edge links to a target only when exactly one symbol matches — first by an exact qualified-name match, then falling back to a unique bare-name match. A genuinely ambiguous name (the same bare name in two places, with no qualifier to tell them apart) is left **unresolved** rather than linked to a guess — `pgraph` never invents a false edge, because a wrong edge would make `impact`/`callers`/`trace` lie. Calls into the standard library or external packages have no symbol in the repo and likewise stay unresolved.

For **Go**, `qname` is package- and receiver-qualified — a package-level `New` in package `filesink` becomes `filesink.New`, and a method becomes `filesink.Writer.Write`. Call sites are qualified the same way: `filesink.New(...)` and same-package `New()` calls both resolve to `filesink.New`, so common names (`New`, `Write`, `Close`, `Run`) no longer collapse into one ambiguous bucket. Two limitations are by design: a method called through a variable (`w.Write()`) keeps the bare name because the receiver's type isn't inferred, and a same-package call in a file that uses a dot-import (`import . "x"`) is left bare to avoid mis-qualifying a name that may belong to the dot-imported package. Other languages (TypeScript/JavaScript, Python, C++) qualify `qname` by lexical nesting (`Class.method`) as before.

> The Go `qname` format changed in schema version 2. An existing `.pgraph/graph.db` from an older version is detected as stale and fully rebuilt on the next `index`/`/p-graph:sync` rather than incrementally patched.

Everything is stored in a local SQLite database at `.pgraph/graph.db` (gitignored, rebuildable at any time — it is never committed). The schema is append-friendly: a full index truncates and repopulates; an incremental index (`--changed`) diffs by commit SHA against the last indexed state, reparses only the changed files, and splices their symbols and edges back in.

The graph is purely local — there is no remote service, no MCP server, and no data leaves the machine.

## Design

See [`docs/superpowers/specs/2026-06-15-p-graph-design.md`](./docs/superpowers/specs/2026-06-15-p-graph-design.md) and [`docs/superpowers/plans/2026-06-15-p-graph.md`](./docs/superpowers/plans/2026-06-15-p-graph.md).

## Validate

```bash
claude plugin validate .
```
