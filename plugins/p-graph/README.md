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
| `/p-graph:sync` | Explicitly rebuild the graph — full (`--full`) or incremental (`--changed`). Day-to-day freshness is automatic (queries auto-refresh); use this for a full rebuild after a big refactor or to warm the graph after a pull. |
| `/p-graph:query` | Answer a natural-language structural question ("who calls X", "what breaks if I change Y", "how does X reach Y") by running the right `pgraph` commands and synthesizing a `file:line`-cited answer. The answer is ephemeral — returned in the conversation, never written to a file. |
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

Structural queries **auto-refresh** the graph before answering: `pgraph` reindexes
changed files first (incrementally, git-based), so day-to-day freshness is
automatic and you rarely need `/p-graph:sync`. Pass `--stale-ok` or set
`PGRAPH_AUTOREFRESH=0` on any query to skip the refresh and answer from the graph
as-is (you'll get a `⚠ p-graph STALE` note on stderr when it's stale). Use the
graph to find candidates fast and to get a transitive `impact` sketch in one
call. Use grep to confirm a count: on a 900-file Go repo a text search costs
about the same as a graph query, and it cannot silently omit a hit.

## How it works

`pgraph` uses [web-tree-sitter](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web) (vendored WASM grammars, no network required) to parse every source file into an AST, then extracts:

- **Symbols** — functions, methods, classes, structs, interfaces, type aliases, enums, and arrow-function variables/fields.
- **Edges** — call references (including `new` and method calls), `import` statements, and C/C++ `#include` directives.

### Name resolution

Each symbol carries a bare `name` (used for search/UX) and a qualified `qname`. Call edges are resolved conservatively: an edge links to a target only when exactly one symbol matches — first by an exact qualified-name match, then falling back to a unique bare-name match. A genuinely ambiguous name (the same bare name in two places, with no qualifier to tell them apart) is left **unresolved** rather than linked to a guess. That guard is not a proof of correctness: the resolver matches names, not types. A call on a function parameter or a local variable has no recorded type. So a bare name that is unique in the repo still links — even when the real receiver is a different type. Interface dispatch is not analysed, so a call through an interface parameter or local variable behaves the same way: no type to check, and no warning if the name it links to is the wrong one. Calls into the standard library or external packages have no symbol in the repo and stay unresolved the same way.

Measured on gohugoio/hugo at `8a468df065a75c1c7cf9f6850f32148746590ea5`: in a hand-checked sample of 20 resolved Go call edges, exact qualified matches were right in 15 of 15 cases and bare-name matches in 4 of 5. The sample is small, so read it as a rough rate, not a guarantee. Treat a `callers` row as a strong lead, not as a fact.

For **Go**, `qname` is package- and receiver-qualified — a package-level `New` in package `filesink` becomes `filesink.New`, and a method becomes `filesink.Writer.Write`. Call sites are qualified the same way: `filesink.New(...)` and same-package `New()` calls both resolve to `filesink.New`, so common names (`New`, `Write`, `Close`, `Run`) no longer collapse into one ambiguous bucket.

A call on the **enclosing method's own receiver** is resolved from the receiver's type, which the syntax states outright: `s.calc()` inside `func (s *Server) Run()` links to `main.Server.calc`, and the same holds for `this.m()` in TypeScript/JavaScript and C++ (`this->m()`) and `self.m()` / `cls.m()` in Python, where the owning class comes from lexical nesting. This is the most common call shape in method-heavy code, and a bare `m` would collide with every same-named method in the repo. If the qualified target does not exist — the method is inherited, or promoted from an embedded Go struct — the bare-name fallback still applies, so nothing that used to link stops linking. A receiver that is not the enclosing one (a parameter, a local, an expression like `(&Server{}).Run()`) is left alone.

A method called through a **struct field of the enclosing method's receiver** — `s.dimpleCore.Action()` inside `func (s Server) DoAction()` — is also resolved, using a lightweight, best-effort type inference. During extraction `pgraph` records each struct's field types (`events.Server.dimpleCore` → `core.Core`, pointer stripped); at build time it types the receiver (`s` is `events.Server`), looks the field up, and links the call to `core.Core.Action` — value and pointer receivers alike.

The edge is created only when the field's type is known and exactly one method matches that type's qname. **The headline guard:** when the field's type is known but the resolver cannot link into it — the type lives outside the repo, or it is a repo-defined interface — the call is refused outright, whether or not the bare method name is unique in the repo. An interface's methods are signatures, not callable code, and which implementation actually runs is a runtime decision (dynamic dispatch), so the graph cannot guess it. This refusal does not wait for a name clash: hugo's `WriteRune` is the only Go symbol in the whole repo with that name, and a field typed to the standard library's `bytes.Buffer` still shows up as a gap row instead of a resolved (and wrong) edge.

This guard is not airtight. Go's `qname` comes from a package's *declared* name (`package config`), not its file path. Two different repo packages that both declare `package config` share one qname namespace. A field typed `config.Value` can then resolve to the wrong package's method, if only one of the two happens to define a matching symbol.

A field the extractor cannot type at all — a slice, map, func, or channel field, a field chain deeper than one level (`s.a.b.M()`), or a same-package call in a file that uses a dot-import (`import . "x"`) — keeps the old **bare-name fallback**: link only on a unique bare-name match, else leave unresolved. A method promoted from an embedded repo type is still allowed through this fallback. The fallback links silently, with no warning, and possibly to the wrong symbol. Other languages (TypeScript/JavaScript, Python, C++) qualify `qname` by lexical nesting (`Class.method`) as before.

### Incompleteness is reported, not hidden

Dropping an ambiguous call keeps `pgraph` from inventing a false edge, but it costs coverage: the call site simply disappears from the graph. Queries walk resolved edges only, so without a report "nothing calls this" and "I could not tell what this calls" would print exactly the same — a silent hole. For the question people actually ask a code graph ("did I find **every** call site?"), a missing edge is as damaging as a wrong one, and harder to notice.

So every graph query names its own gaps. `callers`, `callees`, `impact` and `context` print, after the rows:

```
⚠ 3 call sites missing from this answer:
    internal/api/server.go:41  api.Server.HandleList -> ListGroups
    internal/api/server.go:58  api.Serve -> bp.ListGroups
    web/boot.ts:12  outside any indexed symbol -> start
  + 12 same-name call sites in files that do not import the target's package — likely unrelated, not listed.
  + 365 calls the graph found nothing to link to (stdlib, third party, builtins, or a repo call it never indexed).
  Confirm with a text search before treating this answer as complete.
```

A gap is matched by the **bare name** each call site actually wrote, not by the name you asked about. That is what finds a call made through an import alias (`bp.ListGroups` for `bufferpool.ListGroups`), through a local variable that shadows a package name, or through a receiver-qualified guess whose target does not exist.

Three groups are reported separately, so the list stays short enough to read:
- call sites that may be a real miss — **listed**, up to 20 rows, then `… and N more`;
- same-name call sites in files that cannot even see the target's package — **counted**, not listed;
- calls the graph found nothing to link to — **counted**, not listed.

`--json` returns every row with its `reason` and `reachable` fields.

`callers` also cannot show a caller row for a call made outside any indexed symbol — at module scope, or inside a callback that is not a definition. Those call sites are resolved in the graph but have no source symbol, so they appear in the gap report as `outside any indexed symbol` instead of vanishing.

`impact` reports the whole **frontier** — gaps naming the target *and* gaps naming anything the walk already reached, which is where it stopped. `trace` says so too: a missing path prints `(no path — but N/M call sites are unattributed, so a real path may be invisible to the graph)`. `status` carries the repo-wide share as `unattributed calls N/M`. With `--json`, `callers`/`callees`/`impact` return `{ <command>: [rows], gaps: [gap rows] }`; `context` returns three gap lists — `gaps_in`, `gaps_out`, and `gaps` (the two merged with duplicates removed, since a wrapper-delegation call site can appear in both directions).

One thing the reports cannot fix: `callers`, `callees` and `impact` match a bare `name` as well as a `qname`, so `callers Get` merges the callers of *every* symbol named `Get`. Ask by `qname` (`callers store.Postgres.Get`) whenever a name is shared.

> The Go `qname` format changed in schema version 2, schema version 3 added the struct-field-type table plus the field-selector call resolution above, schema version 5 made a call on the enclosing receiver (`s.M()`, `this.M()`, `self.M()`) receiver-qualified, and schema version 6 (current) added the `dst_bare`/`lang`/`external` columns on `edges` and the `#embed` rows in `field_types` that the guards above rely on. A schema bump before 6 left an old `.pgraph/graph.db` in place and relied on the next `index`/`/p-graph:sync` to fully rebuild it. From schema 6 on, a new column can never be added to a table that already exists, so a bump instead **drops the graph tables as soon as the store is opened** — the graph is empty until the next query or sync rebuilds it. `status` reports this as `- rebuild pending (schema upgrade)` until then.

Everything is stored in a local SQLite database at `.pgraph/graph.db` (gitignored, rebuildable at any time — it is never committed). The schema is append-friendly: a full index truncates and repopulates; an incremental index (`--changed`) diffs by commit SHA against the last indexed state, reparses only the changed files, and splices their symbols and edges back in.

The graph is purely local — there is no remote service, no MCP server, and no data leaves the machine.

## Design

Design specs and implementation plans for this plugin live under [`docs/`](./docs/).

## Validate

```bash
claude plugin validate .
```
