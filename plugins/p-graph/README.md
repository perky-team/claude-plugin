# p-graph

A Claude Code plugin that indexes any git repo into a local SQLite code knowledge graph and answers structural questions — where a symbol is defined, what calls it, what breaks if it changes, how one symbol reaches another — from the index instead of grepping the whole tree. Every answer marks the rows it is sure of, names the call sites it missed, and tells you to confirm the count with a text search. Fully local, no MCP server.

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

Go gives the best answers. Go writes a type next to the name it declares, so `pgraph` can record that type and check a call against it. The other three languages have no type table yet, so more of their rows are guesses — see [Name resolution](#name-resolution).

**C++ is narrower than the other three.** It indexes a method defined outside its class (`bool Table::Save(int id) { … }` in the `.cc`, `class Table` in the `.h`) and it resolves a call written `Class::method(...)`. That much is usable: on leveldb's `WriteBatchInternal::Count`, `callers` gave 11 rows, all correct, with nothing missing.

But a call written on a value (`t->Save(...)`, `obj.m()`) has no type to check, and that is about 40% of C++ calls — those rows are guesses or gaps. Fixing them needs a C++ type table, which is a task of its own. Two more limits: a pure declaration is not indexed, so a pure virtual declared in a header with no definition in the repo is not in the graph at all; and there is no preprocessor expansion beyond `#include` tracking, so a macro-generated name is missed.

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
| `impact <name>` | Transitive callers — what breaks if the symbol changes. Follows certain edges only, so the answer is a floor, not a ceiling. |
| `trace <from> <to>` | A call path between two symbols. |
| `context <q>` | A symbol plus its immediate callers and callees. |
| `explore <names…>` | Several symbols at once, in one response. Definitions only — no callers, no callees, no gap banner. |
| `files <path>` | Files under a path with their symbol counts. |
| `index [--full\|--changed]` | Build or rebuild the graph. `--changed` (default) reparses only files modified since the last indexed commit; `--full` rebuilds from scratch. |
| `status` | Node, edge, and file counts; drift since last index. Drift counts only files a refresh would actually reparse, so editing a `README.md` never shows as drift. |

Structural queries **auto-refresh** the graph before answering: `pgraph` reindexes
changed files first (incrementally, git-based), so day-to-day freshness is
automatic and you rarely need `/p-graph:sync`. Pass `--stale-ok` or set
`PGRAPH_AUTOREFRESH=0` on any query to skip the refresh and answer from the graph
as-is (you'll get a `⚠ p-graph STALE` note on stderr when it's stale). One case
does not answer at all: right after a plugin upgrade that changes the graph
format, the first command erases the old graph so the next index can rebuild it.
With the refresh skipped, nothing rebuilds it and there is no answer to give, so
the query says the graph was erased and exits `4` — in text and in `--json`
(`{"error":"graph_erased"}`) — instead of printing an empty list. Run
`pgraph index --full`, or drop the opt-out. Use the
graph to find candidates fast and to get a transitive `impact` sketch in one
call. Use grep to confirm a count: on a 900-file Go repo a text search costs
about the same as a graph query, and it cannot silently omit a hit.

## How it works

`pgraph` uses [web-tree-sitter](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web) (vendored WASM grammars, no network required) to parse every source file into an AST, then extracts:

- **Symbols** — functions, methods, classes, structs, interfaces, namespaces, type aliases, enums, and arrow-function variables/fields.
- **Edges** — call references (including `new` and method calls), `import` statements, and C/C++ `#include` directives.

### Name resolution

Each symbol carries a bare `name` (used for search) and a qualified `qname`. A call links to a target only when exactly one symbol matches. What separates a good answer from a bad one is **why** it matched, so every resolved row is marked one of two ways.

**Certain** — the graph had a recorded fact to check the call against:

- the call site wrote the qualified name itself (`filesink.New(...)`, `Table::Check(3)`), and exactly one symbol carries that `qname`; or
- the graph knows the receiver's type. Go writes the type down, so four shapes count: a method's own receiver (`s.M()`), a struct field of that receiver (`s.store.Get()`), a parameter (`func f(st *store.Store) { st.Get() }`), and a local or package-level variable (`var st store.Store`); or
- **the definition is in scope where the call is written.** A plain `walk(1)` in JavaScript, TypeScript, Python or C++ first looks for a `walk` in the calling file: one nested in a scope that holds the call site, else one at file top level. Scope is read, not guessed, so these rows are certain — and they come first, because a top-level function in those languages has a bare `qname`, which would otherwise let the rule above match a same-named function in a file the call site never heard of. Two definitions of one name in one scope resolve to neither. A call written on a value (`o.walk()`) is not covered by this: a function in scope is not a member of anything.

**Guess** — the only reason to link was that a bare method name happened to be unique in the whole repo. The receiver's type was unknown, so the graph picked the one symbol that shares the name. Guessed rows print apart, under their own heading:

```
UNVERIFIED: 1 more caller, matched by name only (guess) — the graph could not see the receiver's type, so this one may be a different symbol with the same method name:
    method app.Server.Guessed  app/app.go:28  func (s *Server) Guessed() {
```

`impact` follows **certain edges only**. It never walks a guess, so its answer is a floor, not a ceiling. It says how many edges it refused:

```
1 guessed edge (receiver type unknown) near this target was not followed, so a real impact through one may be missing.
```

With `--json`, that count is the `skipped_guesses` field.

Two shapes are refused outright rather than guessed:

- **A receiver whose type is known but lives outside the repo.** A field typed `bytes.Buffer` calling `Fetch` gives a gap row, not a link to the one repo method named `Fetch`. The refusal does not wait for a name clash — knowing the type is not a repo type is enough. A field typed as a repo *interface* is refused the same way: which implementation runs is a runtime decision, so the graph will not pick one. That is why hugo's real `w.delegate.WriteRune(r)` call site is named in the gap banner instead of resolved.
- **A member call whose target has no owner.** A call written `x.m()`, `x->m()` or `this.m()` can only reach a symbol whose owner is a class, struct or interface. That is what stops one ten-line arrow function named `end`, declared inside a single method body, from answering all 825 `.end()` calls in got. Go is exempt: Go writes a package call as a member access too (`fmt.Println`), and a Go method carries its receiver in its `qname` instead of having an owner node.

#### What it measures at

Every number below comes from [the results document](./docs/superpowers/plans/2026-08-01-p-graph-correct-answers-results.md), which lists the seven corpora and their commits. Read the sample sizes, not just the fractions.

Hand-checked precision on gohugoio/hugo at `70db201ed4f76d0b80c568ffa6b1d35071aabd22`:

| Sample | Size | Result |
|---|---|---|
| resolved Go call edges, drawn uniformly at random | 25 | **25 correct** |
| the hardest class: a guess into a package the calling file neither belongs to nor imports | 15 | **12 correct** — 20% wrong, down from 47% before this work |

Both samples were needed. The uniform one shows 0% wrong; the hard class holds only 369 of hugo's 15,713 resolved Go edges (2.3%), so a uniform draw would need about 130 rows to expect even three from it. All three wrong rows in the hard sample share one shape the work did not cover: **a struct field that holds a function** is matched as if it were a method.

Across 22 symbols in four languages, 1,724 real call sites found by text search:

| Where the call site shows up | Count | Share |
|---|---|---|
| a resolved row in the answer | 1,569 | 91.0% |
| named in the gap report | 153 | 8.9% |
| **nowhere in the answer** | **2** | **0.12%** |

Both silent cases sit in one nest file that produced no symbols before this work either. They are pre-existing and have nothing to do with resolution.

Of the resolved rows in that same set:

| | Resolved rows | False | False rate |
|---|---|---|---|
| before this work | 2,767 | 1,188 | 42.9% |
| now | 1,734 | 165 | 9.5% |
| now, certain rows only | 1,352 | **0** | **0.0%** |
| now, guessed rows only | 382 | 165 | 43.2% |

**No certain row in that set was false. Every false row is marked a guess.** Treat a guess as a lead and check it. Re-measured on fresh clones of all seven repositories with the shipped code: the same 1,734 resolved rows, 1,353 of them certain, none false — 1,345 checked mechanically and 8 read by hand. The row-level evidence is in `docs/superpowers/plans/2026-08-04-p-graph-remeasured.md`.

One shape the measured set did not contain was found afterwards and fixed: a plain `walk(...)` in JavaScript, TypeScript or Python used to match a top-level function of that name in *any* file, because a top-level function's `qname` is just its name. Now a definition the call site can actually see wins. Measured on nestjs/nest (1,728 files): one certain row was false and is now right, 334 calls that resolved to nothing now resolve, and no call lost its answer. See "Name resolution" below.

#### The two weaknesses to plan around

**1. A receiver typed from a function's return value.** `x := reflect.ValueOf(...)` and `buf := bp.GetBuffer()` record no type: the type is stated in the callee's signature, and the graph does not read across files for it. The call falls back to the unique bare name, so it becomes a guess. This is the largest remaining source of wrong rows. `collections.Namespace.Index` in hugo still prints 26 caller rows where `gopls` says 3, and all 25 false ones have this shape.

**2. A real method with a real owner, called on an untyped value in TypeScript or Python.** The owner rule cannot help here: the target really is a method of a real class, and the receiver's type is simply unknown. got's `setHeader` keeps 89 false rows, requests' `RequestsCookieJar.set` 22, and `.update` 15. Fixing these needs a type table for TypeScript and Python, the way Go has one.

Neither weakness can put a wrong row into the certain list. Every wrong row from both is printed under `UNVERIFIED`.

#### Per-language detail

**Go.** `qname` is package- and receiver-qualified: a package-level `New` in package `filesink` is `filesink.New`, and a method is `filesink.Writer.Write`. Call sites are qualified the same way, so `filesink.New(...)` and a same-package `New()` both resolve to `filesink.New` — common names (`New`, `Write`, `Close`, `Run`) no longer collapse into one bucket. A method on a generic type keeps its receiver too. Go is the only language whose variable types are recorded, and only from shapes that name the type on the spot: `var x T`, `x := T{}`, `x := &T{}`, `x := new(T)`, and a parameter.

One hole in the Go qname: it comes from a package's *declared* name (`package config`), not from its file path. Two repo packages that both declare `package config` share one namespace, so a call can resolve to the wrong package's symbol.

**TypeScript, JavaScript, Python and C++** qualify `qname` by lexical nesting (`Class.method`). A call on the enclosing type — `this.m()`, `this->m()`, `self.m()`, `cls.m()` — is qualified with that type, which keeps a method-heavy repo from collapsing every same-named method into one bucket. No other receiver in these four languages has a recorded type.

**C++** also indexes an out-of-class definition (`bool Table::Save(int id) { … }` in the `.cc`, `class Table` in the `.h`) and a namespace-qualified call (`Table::Check(3)`, `Status::OK()`). A pure declaration is not indexed on purpose, so a pure virtual declared in a header with no in-repo definition is not in the graph.

**Python** treats a call written on a module the repo can import as a qualified call, not a call on a value — `requests.get(...)` resolves, `s.get(...)` does not.

### Incompleteness is reported, not hidden

Refusing a call keeps a wrong edge out of the answer, but the call site then disappears from the graph. Queries walk resolved edges only, so without a report "nothing calls this" and "I could not tell what this calls" would print exactly the same — a silent hole. For the question people actually ask a code graph ("did I find **every** call site?"), a missing edge is as damaging as a wrong one, and harder to notice.

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

`impact` reports the whole **frontier** — gaps naming the target *and* gaps naming anything the walk already reached, which is where it stopped. It also refuses to follow a guessed edge, and counts how many it refused (`skipped_guesses` in `--json`), so an empty `impact` never hides the difference between "nothing depends on this" and "the only ways in were guesses". `trace` says so too: a missing path prints `(no path — but N/M call sites are unattributed, so a real path may be invisible to the graph)`. `status` carries the repo-wide share as `unattributed calls N/M`. With `--json`, `callers`/`callees`/`impact` return `{ <command>: [rows], gaps: [gap rows] }`; `context` returns three gap lists — `gaps_in`, `gaps_out`, and `gaps` (the two merged with duplicates removed, since a wrapper-delegation call site can appear in both directions).

One thing the reports cannot fix: `callers`, `callees` and `impact` match a bare `name` as well as a `qname`, so `callers Get` merges the callers of *every* symbol named `Get`. Ask by `qname` (`callers store.Postgres.Get`) whenever a name is shared.

> The Go `qname` format changed in schema version 2, schema version 3 added the struct-field-type table plus the field-selector call resolution above, schema version 5 made a call on the enclosing receiver (`s.M()`, `this.M()`, `self.M()`) receiver-qualified, and schema version 6 added the `dst_bare`/`lang`/`external` columns on `edges` and the `#embed` rows in `field_types` that the guards above rely on. Schema version 7 (current) added the `guess` and `member` columns on `edges` — the marking the whole answer format now rests on — and receiver-qualified a Go method on a generic type. A schema bump before 6 left an old `.pgraph/graph.db` in place and relied on the next `index`/`/p-graph:sync` to fully rebuild it. From schema 6 on, a new column can never be added to a table that already exists, so a bump instead **drops the graph tables as soon as the store is opened** — the graph is empty until the next query or sync rebuilds it. `status` reports this as `- rebuild pending (schema upgrade)` until then. Upgrading to this version therefore costs every existing user one full reindex.

Everything is stored in a local SQLite database at `.pgraph/graph.db` (gitignored, rebuildable at any time — it is never committed). The schema is append-friendly: a full index truncates and repopulates; an incremental index (`--changed`) diffs by commit SHA against the last indexed state, reparses only the changed files, and splices their symbols and edges back in. A stored `signature` is capped at 300 characters, which is why the database is small: it is a hint for a human reading a search hit, not a copy of the source. The longest one on caddy was 157,787 characters before the cap, and the database shrank from 100.8 MB to 10.5 MB with it.

The graph is purely local — there is no remote service, no MCP server, and no data leaves the machine.

## Design

Design specs and implementation plans for this plugin live under [`docs/`](./docs/).

## Validate

```bash
claude plugin validate .
```
