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

Every language now has a type table: `pgraph` records the type the source writes next to a name and checks a call against it. Go and C++ are the most complete, TypeScript came last, and Python reads only a name bound to a constructor. What is left over is a guess — see [Name resolution](#name-resolution).

**C++ is narrower than the other three.** It indexes a method defined outside its class (`bool Table::Save(int id) { … }` in the `.cc`, `class Table` in the `.h`), and it resolves both a call written `Class::method(...)` and a plain `method(...)` written inside the class or namespace that owns it — the lookup walks outward the way C++ does. Ask for a symbol however C++ writes it: `Table::Save`, `ns::Table::Save`, or just `Save`. On leveldb's `WriteBatchInternal::Count`, `callers` gives 11 rows, all correct, with nothing missing.

A call written on a value (`t->Save(...)`, `obj.m()`) is about 40% of C++ calls, and it is read too: when the source writes the receiver's type — on a local, a parameter or a class field — the call resolves to that type's method exactly. Measured on leveldb, that took the certain share of those calls from 0 of 3,681 to 1,743, and the repo's guesses from 58% of resolved edges down to 4.6%. A `virtual m() = 0;` is indexed even though it has no definition, so a C++ interface method is a symbol you can ask about; ordinary declarations are still left out, because their definition is indexed already and two nodes on one qname resolve to neither.

What is still missing: a receiver with no type written anywhere near it (a global, a chained call) stays a guess or a gap — 648 calls in leveldb. Inheritance is not indexed, so a call to a method a class inherits rather than declares does not resolve; measured, that is 35 calls in leveldb and 112 in re2. And there is no preprocessor expansion beyond `#include` tracking, so a macro-generated name is missed.

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
| `callers <name>` | Everything that calls the named symbol, with the `file:line` of each call. |
| `callees <name>` | Everything the named symbol calls. |
| `impact <name>` | Transitive callers — what breaks if the symbol changes. Follows certain edges only, so the answer is a floor, not a ceiling. |
| `trace <from> <to>` | A call path between two symbols. |
| `context <q>` | A symbol plus its immediate callers and callees. |
| `explore <names…>` | Several symbols at once, in one response. Definitions only — no callers, no callees, no gap banner. |
| `files <path>` | Files under a path with their symbol counts. |
| `index [--full\|--changed]` | Build or rebuild the graph. `--changed` (default) reparses only files modified since the last indexed commit; `--full` rebuilds from scratch. |
| `status` | Node, edge, and file counts; drift since last index. Drift counts only files a refresh would actually reparse, so editing a `README.md` never shows as drift. |

**Naming a symbol.** Anywhere a command takes `<name>` you can write the bare name, the
full `qname`, or any tail of it — `Get`, `pkg.Store.Get`, `Store.Get`. C++ scope with
`::` works too: `WriteBatchInternal::Count`. A name that fits several symbols is not
picked for you: the answer names all of them on its first line. A name nothing carries
answers `no symbol named X in the graph`, which is a different thing from "nothing calls
it" and never claims to be complete.

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
- **a TypeScript declaration states the type.** `function read(c: Conn)` or `const c = new Conn()`, then `c.query(...)`. A parameter with **no** annotation in a `.ts` file states the opposite fact — its type comes from the signature it is passed to, usually a library's — so the call is refused and reported instead of guessed. An explicit `any` is an annotation, not a missing one, and keeps its guess.
- **a Python name bound to a constructor.** `jar = RequestsCookieJar()` then `jar.set(...)`: the source names the class, so the call resolves to it. A constructor from outside the repo (`close_server = threading.Event()`) records that the type is not ours, and the call is refused and reported instead of guessing the one repo method that shares the name.
- **the callee's signature says what the receiver is.** `c := store.Open()` then `c.Query(...)`: the call site names no type, but `Open` declares one result and the graph reads it. Only a single named result counts — `(T, error)` says nothing about one variable, and a callee outside the repo has no signature to read, which is exactly when a bare-name guess used to invent a caller; those calls are now refused and reported as gaps instead.
- **the definition is in scope where the call is written.** A plain `walk(1)` in JavaScript, TypeScript, Python or C++ first looks for a `walk` in the calling file: one nested in a scope that holds the call site, else one at file top level. Scope is read, not guessed, so these rows are certain — and they come first, because a top-level function in those languages has a bare `qname`, which would otherwise let the rule above match a same-named function in a file the call site never heard of. Two definitions of one name in one scope resolve to neither. A call written on a value (`o.walk()`) is not covered by this: a function in scope is not a member of anything.
- **a C++ declaration states the receiver's type.** `Batch b; b.Put(k)`, `Batch* p = Make(); p->Put(k)`, a parameter `void f(const Batch& b)`, or a class field `Batch rep_;` used as `rep_.Put(k)` from a method written anywhere — including the usual case where the field is in a header and the method in a `.cc`. A call through a field of a typed receiver (`h->rep.Put(k)`) counts too. The written name is resolved to a class first, and only when exactly one class in the repo carries it; then that class's method. When the type IS written and it is not a repo class — `std::string s; s.size()` — the call is refused and reported instead of guessing the one repo method that shares the name.
- **a Go interface declares the method.** `func Run(p config.Provider) { p.Set(k, v) }` — the
  parameter's type is an interface, and the interface's own methods are symbols, so the call resolves
  to `config.Provider.Set`. It does NOT resolve to any implementation: which one runs is decided at
  run time. Ask about a concrete implementation and the answer says so on its own line — `ℹ N call
  sites reach this method through config.Provider.Set` — which is the part a text search cannot work
  out. "Implements" is decided by the method set, the way Go decides it. TypeScript interfaces work
  the same way.
- **a TypeScript class field states the type.** `private readonly svc: Svc;` or
  `constructor(private readonly svc: Svc)`, then `this.svc.find(id)`. The field is looked for on the
  class the call is written in, then on each class it extends, and the type it names is followed
  through one `type X = Y` alias. An interface counts as a type: `Serializer.serialize` is a symbol
  like any other. This is the shape TypeScript writes most — 1,019 calls in nestjs/nest, none of them
  resolved before.
- **a TypeScript call written on a class name.** `NestFactory.create(app)` names its owner outright,
  so it resolves to that class when exactly one class carries the name. A module-level
  `export const X = new T()` counts too — that is how `NestFactory` itself is declared. A local
  variable of the same name wins over both, because then the call is a call on a value.
  `JSON.parse(…)`, `Object.assign(…)` and the rest of JavaScript's own globals are marked as outside
  the repo, so they are neither guessed at nor reported as gaps; a repo that declares its own class of
  that name still wins.
- **C++ name lookup walks outward.** A plain `Scale(v)` written inside `Box::Grow` is looked for in `Box` first, then in each enclosing namespace, then globally — the order C++ itself uses. The walk stops at the first scope that holds the name, and it never happens at all when the inner scope holds it, even when overloads leave the graph unable to say which one is meant: `InternalKeyComparator::Compare` calling its own other overload must not answer with a free `Compare`. Two candidates in the scope it reaches resolve to neither.

**Guess** — the only reason to link was that a bare method name happened to be unique in the whole repo. The receiver's type was unknown, so the graph picked the one symbol that shares the name. Guessed rows print apart, under their own heading:

```
UNVERIFIED: 1 more caller, matched by name only (guess) — the graph could not see the receiver's type, so this one may be a different symbol with the same method name:
    method app.Server.Guessed  app/app.go:28
```

`impact` follows **certain edges only**. It never walks a guess, so its answer is a floor, not a ceiling. It says how many edges it refused:

```
1 guessed edge (receiver type unknown) near this target was not followed, so a real impact through one may be missing.
```

With `--json`, that count is the `skipped_guesses` field.

Two shapes are refused outright rather than guessed:

- **A receiver whose type is known but lives outside the repo.** A field typed `bytes.Buffer` calling `Fetch` gives a gap row, not a link to the one repo method named `Fetch`. The refusal does not wait for a name clash — knowing the type is not a repo type is enough. A field typed as a repo *interface* is refused the same way: which implementation runs is a runtime decision, so the graph will not pick one. That is why hugo's real `w.delegate.WriteRune(r)` call site is named in the gap banner instead of resolved.
- **A member call whose target has no owner.** A call written `x.m()`, `x->m()` or `this.m()` can only reach a symbol whose owner is a class, struct or interface. That is what stops one ten-line arrow function named `end`, declared inside a single method body, from answering all 825 `.end()` calls in got. Go is exempt: Go writes a package call as a member access too (`fmt.Println`), and a Go method carries its receiver in its `qname` instead of having an owner node.

#### A function passed as a call argument is a definition too

In TypeScript and JavaScript, a function handed to another call — `describe('x', () => …)`, `it('y', async () => …)`, `beforeEach(() => …)` — is indexed as a definition, so a call written inside it has a caller. Without this, nearly all test code sat outside every symbol: 94% of this repo's own TypeScript call sites had no caller, 80% of got's and 74% of nest's.

Such a definition is named after the call beside it. `it('reads the config', …)` reads as `it:reads the config`, and a call that passes no string reads as `beforeEach@42`. In a `callers` list that is the test's own name:

```
function describe:Get URL (Express Application).it:should be able to get the IPv6 address  integration/nest-application/get-url/e2e/express.spec.ts:24
```

Three things this deliberately does **not** do:

- **A callback inside a named function is not indexed.** An inline `xs.map(x => target() + x)` written inside `named` still reports `named` as the caller. That is the useful answer, and `impact` can keep walking from it — nothing calls an arrow that is passed as a value.
- **It cannot be the target of a call.** No identifier can hold a `:` or a `@`, so no call resolves to one of these definitions. They add callers, never edges.
- **It does not rename anything.** A `const helper = …` written inside a `describe` keeps the bare `qname` it always had. Only nested callbacks are qualified by their outer callback.

The cost, measured on nestjs/nest: a full index takes 17% longer and the database grows by about a third, because the graph holds twice the nodes. An incremental index and every query are unchanged. `search` gains rows for test callbacks; for a plain symbol name the real definition still comes first.

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
| now | 1,619 | at most 31 | 1.9% |
| now, certain rows only | 1,411 | **0** | **0.0%** |
| now, guessed rows only | 208 | at most 31 | 14.9% |

Two changes moved those rows. Reading a Go callee's declared result removed 27 false rows (24 on one hugo symbol, 3 on another) and turned 3,112 hugo rows from guesses into certain ones — repo-wide, certain call edges went 12,569 → 15,681 and guesses 5,002 → 2,030; on caddy 6,071 → 6,496 and 1,610 → 1,207. Reading a Python constructor then took `RequestsCookieJar.set` from 38 rows with 1 certain to 22 rows with **16 certain, every one a real `jar.set(...)`**, and moved its 16 `threading.Event().set()` call sites into the gap report; `requests.get` gained 20 more real rows, because `s = requests.Session()` now types `s`. Reading TypeScript last took got's `setHeader` from 91 rows with 89 false to **5 rows**, moving 88 wrong ones into the gap report, and made 20 of nest's `createNestApplication` rows certain without losing any of its 190.

"At most" is exact about what is known: every certain row is audited, so a false row can only be among the guesses, and 315 is their ceiling.

**Do not read `0 of 1,411` as a promise about your repo.** It is a fact about those seven repositories and those 22 symbols. All 4,514 certain rows of the repository p-graph itself lives in were later audited the same way, and **11 were false — 0.24%**. Both causes are named in `docs/superpowers/plans/2026-08-04-p-graph-follow-up.md` (items 3 and 4) and neither is visible in the seven measured repos:

- **A call on a parameter.** `textOf(it)` inside `applyFilterList(items, filter, textOf)` reaches a `function textOf` in another folder and is called certain. Reading lexical scope refuses a name the calling file *defines*, and a parameter is not a definition.
- **A mixed `.ts` / `.mjs` repo.** Every rule needs the same language on both ends, so a `.ts` test cannot reach the `.mjs` function it imports. That much is only lost recall, and it is reported. The harm is that with the right target invisible, one same-language candidate anywhere in the repo looks unique and is taken as certain.

**No certain row in that set was false. Every false row is marked a guess.** Treat a guess as a lead and check it.

**Re-check it yourself**, in one command — it clones the same seven repositories at the same commits, indexes them, and audits every certain row:

```bash
node plugins/p-graph/scripts/measure.mjs
```

It exits non-zero if a single certain row has no reason to mean the symbol it names. Last run: 1,734 resolved rows, 1,353 certain, all explained — 1,345 mechanically, 8 read by hand and listed in the output. The write-up is in `docs/superpowers/plans/2026-08-04-p-graph-remeasured.md`.

One shape the measured set did not contain was found afterwards and fixed: a plain `walk(...)` in JavaScript, TypeScript or Python used to match a top-level function of that name in *any* file, because a top-level function's `qname` is just its name. Now a definition the call site can actually see wins. Measured on nestjs/nest (1,728 files): one certain row was false and is now right, 334 calls that resolved to nothing now resolve, and no call lost its answer. See "Name resolution" below.

#### The two weaknesses to plan around

**1. A receiver typed from a function's return value.** `x := reflect.ValueOf(...)` and `buf := bp.GetBuffer()` record no type: the type is stated in the callee's signature, and the graph does not read across files for it. The call falls back to the unique bare name, so it becomes a guess. This is the largest remaining source of wrong rows. `collections.Namespace.Index` in hugo still prints 26 caller rows where `gopls` says 3, and all 25 false ones have this shape.

**2. A real method with a real owner, called on an untyped value in TypeScript or Python.** The owner rule cannot help here: the target really is a method of a real class, and the receiver's type is simply unknown. Reading TypeScript annotations and Python constructors cut this down a lot (see the paragraph above), and what is left is small but not gone: got's `setHeader` keeps 3 guessed rows of 5, requests' `RequestsCookieJar.update` 10 of 11, and `.set` 6 of 22. Closing the rest needs type *inference* rather than type reading — a contextual callback type in TypeScript, an attribute type in Python.

Neither weakness can put a wrong row into the certain list. Every wrong row from both is printed under `UNVERIFIED`.

#### Per-language detail

**Go.** `qname` is package- and receiver-qualified: a package-level `New` in package `filesink` is `filesink.New`, and a method is `filesink.Writer.Write`. Call sites are qualified the same way, so `filesink.New(...)` and a same-package `New()` both resolve to `filesink.New` — common names (`New`, `Write`, `Close`, `Run`) no longer collapse into one bucket. A method on a generic type keeps its receiver too. Go is the only language whose variable types are recorded, and only from shapes that name the type on the spot: `var x T`, `x := T{}`, `x := &T{}`, `x := new(T)`, and a parameter.

One hole in the Go qname: it comes from a package's *declared* name (`package config`), not from its file path. Two repo packages that both declare `package config` share one namespace, so a call can resolve to the wrong package's symbol.

**TypeScript, JavaScript, Python and C++** qualify `qname` by lexical nesting (`Class.method`). A call on the enclosing type — `this.m()`, `this->m()`, `self.m()`, `cls.m()` — is qualified with that type, which keeps a method-heavy repo from collapsing every same-named method into one bucket.

A TypeScript or Python `qname` carries no module path, so two files that declare a class of one name share one `qname`. The resolver refuses a call that could mean either, and `callers` says so and names the files. On nestjs/nest, which ships the same service class in six sample apps, 393 of 9,852 `qname`s belong to more than one symbol.

**C++** also indexes an out-of-class definition (`bool Table::Save(int id) { … }` in the `.cc`, `class Table` in the `.h`) and a namespace-qualified call (`Table::Check(3)`, `Status::OK()`). A pure declaration is not indexed on purpose, so a pure virtual declared in a header with no in-repo definition is not in the graph.

**Python** treats a call written on a module the repo can import as a qualified call, not a call on a value — `requests.get(...)` resolves, `s.get(...)` does not.

### A caller row is the call site

`callers` and `callees` print the `file:line` where the call is **written**, not where the
calling function is declared, and a caller that calls twice shows both lines:

```
target: function caddyhttp.SanitizedPathJoin  modules/caddyhttp/caddyhttp.go:252
method fastcgi.Transport.buildEnv  modules/caddyhttp/reverseproxy/fastcgi/fastcgi.go:310, 372
method fileserver.FileServer.ServeHTTP  modules/caddyhttp/fileserver/staticfiles.go:296, 327
✓ complete — no gaps: the graph accounted for every call site it found.
```

The first line says which symbol the name resolved to, and names them all if the name is
shared — so a bare name takes one command, not a `search` and then a `callers`. With
`--json` the same two things are `call_sites` on each row and `targets` on the answer.

The signature is no longer on a caller row; `pgraph node <qname>` and `search` still print it.
Both changes come out of the measurement: `callers` used to hold **0 of 32** of the call-site
lines its readers were after, so every one of them ran a text search straight afterwards. See
[`docs/measured-benefit.md`](./docs/measured-benefit.md).

### Completeness is reported too

An answer with nothing missing ends with its own line:

```
✓ complete — no gaps: the graph accounted for every call site it found.
```

`impact` says `✓ complete — no gaps, and no edge was refused.`, which is the stronger claim: it
also refused no guessed edge, so the answer is not a floor. With `--json` the same thing is the
`complete` field on `callers`, `callees`, `impact` and `context`.

This exists because silence was expensive. An answer with no gaps used to just end, and "no banner"
and "I do not know" look the same — so an agent re-ran a text search over a complete answer every
time. Measured across seven public repos, that reflex is where the plugin's extra cost came from;
see [`docs/measured-benefit.md`](./docs/measured-benefit.md). The line never prints on a graph too
old to build the gap report: there, an empty gap list means the report could not be built, not that
nothing is missing.

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

`callers` also cannot show a caller row for a call made outside any indexed symbol — at module scope, or inside a function the graph does not index as a definition, such as one written in an object literal (`foo({ onDone: () => … })`). Those call sites are resolved in the graph but have no source symbol, so they appear in the gap report as `outside any indexed symbol` instead of vanishing. A call inside a test callback used to land here; it does not any more — see "A function passed as a call argument is a definition too" above.

`impact` reports the whole **frontier** — gaps naming the target *and* gaps naming anything the walk already reached, which is where it stopped. It also refuses to follow a guessed edge, and counts how many it refused (`skipped_guesses` in `--json`), so an empty `impact` never hides the difference between "nothing depends on this" and "the only ways in were guesses". `trace` says so too: a missing path prints `(no path — but N/M call sites are unattributed, so a real path may be invisible to the graph)`. `status` carries the repo-wide share as `unattributed calls N/M`. With `--json`, `callers`/`callees`/`impact` return `{ <command>: [rows], gaps: [gap rows] }`; `context` returns three gap lists — `gaps_in`, `gaps_out`, and `gaps` (the two merged with duplicates removed, since a wrapper-delegation call site can appear in both directions).

One thing the reports cannot fix: `callers`, `callees` and `impact` match a bare `name` as well as a `qname`, so `callers Get` merges the callers of *every* symbol named `Get`. Ask by `qname` (`callers store.Postgres.Get`) whenever a name is shared.

For a callback definition, asking by `qname` does not separate them either: a module-scope `beforeEach` on line 9 gives the qname `beforeEach@9` in every file that has one — 40 of them in this repo. The `file:line` printed beside each row is what identifies a hook, not its name.

> The Go `qname` format changed in schema version 2, schema version 3 added the struct-field-type table plus the field-selector call resolution above, schema version 5 made a call on the enclosing receiver (`s.M()`, `this.M()`, `self.M()`) receiver-qualified, and schema version 6 added the `dst_bare`/`lang`/`external` columns on `edges` and the `#embed` rows in `field_types` that the guards above rely on. Schema version 7 added the `guess` and `member` columns on `edges` — the marking the whole answer format now rests on — and receiver-qualified a Go method on a generic type. Version 8 added the return-type rows, version 9 the `decl` column that lets a C++ definition win over its own declaration, version 10 the TypeScript type rows (abstract classes, interface methods, class field types, `#extends` and `#alias:`), and version 11 (current) Go interface methods. A schema bump before 6 left an old `.pgraph/graph.db` in place and relied on the next `index`/`/p-graph:sync` to fully rebuild it. From schema 6 on, a new column can never be added to a table that already exists, so a bump instead **drops the graph tables as soon as the store is opened** — the graph is empty until the next query or sync rebuilds it. `status` reports this as `- rebuild pending (schema upgrade)` until then. Upgrading to this version therefore costs every existing user one full reindex.

Everything is stored in a local SQLite database at `.pgraph/graph.db` (gitignored, rebuildable at any time — it is never committed). The schema is append-friendly: a full index truncates and repopulates; an incremental index (`--changed`) diffs by commit SHA against the last indexed state, reparses only the changed files, and splices their symbols and edges back in. A stored `signature` is capped at 300 characters, which is why the database is small: it is a hint for a human reading a search hit, not a copy of the source. The longest one on caddy was 157,787 characters before the cap, and the database shrank from 100.8 MB to 10.5 MB with it.

The graph is purely local — there is no remote service, no MCP server, and no data leaves the machine.

## Measured benefit

[`docs/measured-benefit.md`](./docs/measured-benefit.md) runs the contest: the same 31 structural
questions put to the same agent twice — once with nothing but `grep` and `Read`, once with p-graph
installed. **Twelve public repos, three per language**, 186 runs in the current set.

**Two things hold up. p-graph invents a third as many call sites, and it tells you when it might be
short. On price there is no difference.**

| What was measured | grep | p-graph | Gap | Verdict |
|---|---|---|---|---|
| "who calls X" — call sites found | **1401 of 1410** | 1392 of 1410 | −9 | **grep** |
| "who calls X" — call sites invented | 51 | **19** | −63% | **p-graph** |
| "who calls X" — cost per question | $0.241 | $0.239 | −1% (0.1 SE) | **noise** |
| "who calls X" — time per question | 44.5 s | 44.6 s | +0% (0.0 SE) | **noise** |
| "who calls X" — steps per question | 7.6 | 7.3 | −4% (0.6 SE) | **noise** |
| "who calls X" — context read back | **632k** | 679k | +7% | **grep** |
| "who calls X" — text searches | 3.7 | **1.9** | −49% | **p-graph** |
| "what breaks if X changes" — cost | $0.86 | **$0.42** | −51% | **p-graph** |
| "what breaks if X changes" — time | 237 s | **91 s** | −62% | **p-graph** |
| "what breaks if X changes" — steps | 50 | **7** | −85% | **p-graph** |
| Answers that admit their own limits | 8% (7/93) | **45% (42/93)** | +37 pts | **p-graph** |

Per language — three repositories each:

| Language | Repos | Call sites found, grep / p-graph | Invented | Cost, grep / p-graph | Cost gap |
|---|---|---|---|---|---|
| Go | hugo, caddy, gin | 331 of 336 / **334 of 336** | 51 / **17** | $0.300 / **$0.251** | **−16%** |
| Python | flask, requests, httpx | 135 of 135 / 135 of 135 | 0 / 0 | $0.184 / $0.180 | −2% |
| C++ | leveldb, re2, spdlog | 476 of 480 / **477 of 480** | 0 / 0 | **$0.301** / $0.327 | **+9%** |
| TypeScript | nest, got, axios | **459 of 459** / 446 of 459 | **0** / 2 | $0.177 / $0.171 | −3% |

**noise** means the gap is under two standard errors. **tie** means the same number on both sides.

Read the recall row carefully. p-graph is nine call sites behind, and that gap is one hard question
having a good day for grep: on `re2::Prog::size` grep scored 57 of 75 in one pass and 75 of 75 in the
next, paying $1.11 and 213 s for the second against $0.74 and 123 s for the first. p-graph scored
74 of 75 both times. An earlier version of this README claimed +22 call sites for C++ on the strength
of the cheap grep run — that claim is withdrawn.

The invented rows come from one question: a call written on caddy's `Handler` interface, which a text
search cannot tell from a call on any of the 31 types that implement it. grep averages 17 invented
sites per run there. On the transitive question, which grep cannot answer in one step, p-graph is half
the cost and takes seven times fewer steps. And it says what it might be missing in 45% of answers
against grep's 8%, which is the gap banner and the guess marking being relayed.

### Every row, per language

Three repositories per language, three runs a side. `text searches` counts Grep and grep through Bash
— a graph query is not a search. The transitive question ("what breaks if X changes") only exists for
Go, so only that table has its rows.

**Go** — hugo, caddy, gin

| What was measured | grep | p-graph | Gap | Winner |
|---|---|---|---|---|
| "who calls X" — call sites found | 331 of 336 | **334 of 336** | +1% | **p-graph** |
| "who calls X" — call sites invented | 51 | **17** | −67% | **p-graph** |
| "who calls X" — cost | $0.300 | **$0.251** | −16% | **p-graph** |
| "who calls X" — time | 65 s | **51 s** | −23% | **p-graph** |
| "who calls X" — tool calls | 7.9 | **6.8** | −13% | **p-graph** |
| "who calls X" — output tokens / context read | 8,609 / 850k | 17,748 / **699k** | +106% / −18% | grep |
| "who calls X" — text searches | 3.8 | **1.9** | −50% | **p-graph** |
| "what breaks if X changes" — cost | $0.86 | **$0.42** | −51% | **p-graph** |
| "what breaks if X changes" — time | 237 s | **91 s** | −62% | **p-graph** |
| "what breaks if X changes" — steps | 50 | **7** | −85% | **p-graph** |
| Answers that admit their own limits | 17% (3/18) | **44% (8/18)** | +28 pts | **p-graph** |

Output tokens are the one row grep wins, and one question does it: on `caddyhttp.Handler.ServeHTTP`
p-graph's answers list far more call sites, because they list them right.

**Python** — flask, requests, httpx

| What was measured | grep | p-graph | Gap | Winner |
|---|---|---|---|---|
| "who calls X" — call sites found | 135 of 135 | 135 of 135 | +0% | tie |
| "who calls X" — call sites invented | 0 | 0 | 0% | tie |
| "who calls X" — cost | $0.184 | $0.180 | −2% | tie |
| "who calls X" — time | 31 s | 32 s | +3% | tie |
| "who calls X" — tool calls | **4.3** | 4.8 | +12% | grep |
| "who calls X" — output tokens / context read | **3,168 / 386k** | 5,538 / 433k | +75% / +12% | grep |
| "who calls X" — text searches | 3.1 | **1.3** | −59% | **p-graph** |
| Answers that admit their own limits | 20% (3/15) | **40% (6/15)** | +20 pts | **p-graph** |

Python is the one language where the graph reads no types at all — flask and requests carry almost no
annotations, and every type row in those two graphs is a dead-end marker. The result is an honest tie.

**C++** — leveldb, re2, spdlog

| What was measured | grep | p-graph | Gap | Winner |
|---|---|---|---|---|
| "who calls X" — call sites found | 476 of 480 | **477 of 480** | +0% | **p-graph** |
| "who calls X" — call sites invented | 0 | 0 | 0% | tie |
| "who calls X" — cost | **$0.301** | $0.327 | +9% | grep |
| "who calls X" — time | **52 s** | 58 s | +11% | grep |
| "who calls X" — tool calls | 9.2 | **8.2** | −11% | **p-graph** |
| "who calls X" — output tokens / context read | 13,072 / **905k** | **11,411** / 1,077k | −13% / +19% | **p-graph** |
| "who calls X" — text searches | 5.1 | **3.0** | −41% | **p-graph** |
| Answers that admit their own limits | 4% (1/27) | **37% (10/27)** | +33 pts | **p-graph** |

C++ is the only language where the graph still costs more than grep, and one question is the whole of
it: `re2::Prog::size` runs $1.46 against $1.11. Five fixes this round took the cost gap from +17% to
+9% and the time gap from +38% to +11% — see [docs/measured-benefit.md](docs/measured-benefit.md).

**TypeScript / JavaScript** — nest, got, axios

| What was measured | grep | p-graph | Gap | Winner |
|---|---|---|---|---|
| "who calls X" — call sites found | **459 of 459** | 446 of 459 | −3% | grep |
| "who calls X" — call sites invented | **0** | 2 | — | grep |
| "who calls X" — cost | $0.177 | $0.171 | −3% | tie |
| "who calls X" — time | **29 s** | 32 s | +12% | grep |
| "who calls X" — tool calls | **4.5** | 4.8 | +7% | grep |
| "who calls X" — output tokens / context read | **4,610 / 355k** | 6,304 / 406k | +37% / +14% | grep |
| "who calls X" — text searches | 2.3 | **1.2** | −49% | **p-graph** |
| Answers that admit their own limits | 0% (0/27) | **48% (13/27)** | +48 pts | **p-graph** |

Every one of the 13 missed call sites is in axios, which is plain JavaScript. With no annotations to
read, `AxiosHeaders.has` degrades to matching by name: the answer mixes true call sites and calls on a
`Set` into one UNVERIFIED block, and the agent drops real ones along with the false. nest and got, both
written in TypeScript, are level with grep on every question.

Every table comes from `measure-agent.mjs --score`. Re-make them with the commands in
[docs/measured-benefit.md](docs/measured-benefit.md#run-it-again).

C++ is where the gap is widest, and it was the other way round two rounds ago. Reading the type the
source writes on a receiver took leveldb's guesses from 58% of resolved edges to 5%. TypeScript was
the last language where p-graph lost — +9% cost, +13% tool calls — and reading the type written on a
class field turned that into −18% cost and −52% tool calls, with nest's certain `x.m()` rows going
2,819 → 3,750. See [docs/measured-benefit.md](docs/measured-benefit.md).

The first pass did not read like that: p-graph was 48% dearer and 59% slower, because `callers`
returned caller *functions* and not call *sites* — 0 of 32 of the lines the question asked for — so
every run had to go and grep for them. Printing the call site closed the gap. C++ then stayed 77%
dearer on its own for one more pass, until a per-language split showed that a `Class::Method` query
matched nothing at all. The page keeps every pass, including a fix that was built, measured, and
changed nothing.

## Design

Design specs and implementation plans for this plugin live under [`docs/`](./docs/).

## Validate

```bash
claude plugin validate .
```
