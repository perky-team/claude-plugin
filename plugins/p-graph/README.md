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

Every language now has a type table: `pgraph` records the type the source writes next to a name and checks a call against it. Go and C++ are the most complete. Python reads parameter, variable and field annotations, `-> T` on a def, an `@property` getter's return type, a name bound to a constructor, and `with C() as x`. A plain `.js` file has no annotations to read, but a name bound to `new C()` is read there too — until recently nothing in a `.js` file was. What is left over is a guess — see [Name resolution](#name-resolution).

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
  out.

  The other direction works too: ask about the interface method itself, and `callers` also reports
  the calls that run a type which implements it — `ℹ N call sites of this method — on
  config.Postgres.Set, which implements it:`, one such line per implementing type. In TypeScript
  "implements" takes THREE checks, not two, and the new one can remove a row: what the class writes
  down beats what its shape suggests. `class C implements Other` is not an implementation of
  `Serializer`, however well its `serialize` fits. Measured on nestjs/nest:
  `ClassSerializerInterceptor` declares `implements NestInterceptor`, sits in another package, and
  used to be reported on 13 call sites of `Serializer.serialize` — the only invented rows in the
  whole four-language study. The clause is read together with what each interface it names extends
  and what each base class of its own declares, and only a clause the graph can read WHOLE may
  refuse anything: a declared name it cannot resolve, or a base class it does not hold, leaves the
  row alone. The check does not apply to Go or JavaScript, which have no `implements` keyword at
  all, nor to a TypeScript class that declares nothing — TypeScript is structurally typed, so such a
  class really can implement an interface without saying so, and there the other two checks decide
  on their own. Those two: the type must carry a method of every name the interface declares, and —
  for the one method asked about — that method's shape must match the interface's (`sigShape` in
  `tools/lib/sig-shape.mjs`). The shape rule is not the same for every language: Go needs an exact
  match, same parameter count and same "does it return something", because that is what Go's own
  compiler demands. TypeScript only needs the implementation to take no more parameters than the
  interface — or any number more, when the interface's member ends in a rest parameter
  (`...args: any[]`) — and does not compare a return type at all, because TypeScript itself allows
  both. When
  a signature line cannot be read at all — a generic method, a callback-typed member, a declaration
  whose parameter list wraps onto the next line — the shape check is skipped and the name match
  stands on its own. Parameter *types* are not compared either, so two same-named, same-shaped
  methods can still be different contracts; that is a known, bounded source of over-report, not a
  certain row. An interface also gains nothing here from Go embedding (`type X interface { Reader;
  Foo() }`) or TypeScript's `extends`: a member the interface only gains that way is never demanded,
  so a type can read as implementing the interface while still missing what the embedded or extended
  interface promises.
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

**1. A receiver typed from a call whose result the graph has no row for.** Two shapes, and only one is still open. `x := newThing()` — a plain function in this repo — IS read: extraction records `x` as `#ret:newThing`, and the resolver follows that to the result type written in `newThing`'s own signature, across files. What stays open is a callee the graph cannot read a result for: one outside the repo (`x := reflect.ValueOf(v)`), or a method on a value that is not typed yet (`buf := bp.GetBuffer()`, where `bp` has to be resolved first — Go stops after one hop, and only Python takes the extra one). Those fall back to the unique bare name and become guesses. This is the largest remaining source of wrong rows: `collections.Namespace.Index` in hugo still prints 26 caller rows where `gopls` says 3, and all 25 false ones have this shape.

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
`impact` prints that first line too, and `context` prints it when the name is shared; all
four carry `targets` in `--json`. Every command that takes a symbol resolves an id, a bare
name or a `qname` the same way — `node` is the one exception, and it takes an id or a
`qname`. `trace` resolves both of its ends the same way, and an end no symbol carries is
reported as `no symbol named X in the graph`, never as `(no path)`.

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
    web/boot.ts:12  file scope -> start
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

A call written outside any function has no enclosing symbol to name — a call at module scope, a Go package-level `var x = pkg.New()`, a `@Injectable()` on a class, or a call inside a function the graph does not index as a definition, such as one written in an object literal (`foo({ onDone: () => … })`). `callers`, `context` and `impact` name the **file** that holds such a call instead, on one row with every line on it: `file app/boot.js  3, 4`. A file row is not stored in the graph — it is built in the read path, because a node spanning the whole file would enclose every top-level definition in it, and a child's `qname` is built from its parent's, so every top-level `qname` would gain a file prefix. A call inside a test callback used to land here too; it does not any more — see "A function passed as a call argument is a definition too" above.

These call sites used to be reported one line at a time in the gap banner, and the banner stops at 20 rows. Measured on hugo: `callers parse.mkItem` named 20 of its 120 file-scope call sites and replaced the rest with `… and 100 more`; across axios, nest, got and hugo, 13 symbols were over that cap and 1,500 call sites were named nowhere. Now `parse.mkItem` is one row carrying all 120 lines and says `✓ complete`, and nest's `Injectable` lists all 199 of its file-scope call sites over 196 file rows, where the banner used to name 20 and hide the rest behind `… and N more`. A file row obeys the usual guess marking, and a row is marked by its most certain line: printed plainly, at least one of its lines is certain — not all of them — and printed under `UNVERIFIED: … (guess)`, every line on it is a guess. `impact` is stricter — it lists only the file-scope calls it is certain about and adds a guessed one to `skipped_guesses`, which blocks `✓ complete`; across ten clones 4,672 of 4,998 resolved file-scope calls (93%) are certain, so 326 are counted rather than listed. A call at file scope the graph could **not** resolve is still a gap, and the banner names it with `file scope` in the middle column.

`impact` reports the whole **frontier** — gaps naming the target *and* gaps naming anything the walk already reached, which is where it stopped. It also refuses to follow a guessed edge, and counts how many it refused (`skipped_guesses` in `--json`), so an empty `impact` never hides the difference between "nothing depends on this" and "the only ways in were guesses". `trace` says so too: a missing path prints `(no path — but N/M call sites are unattributed, so a real path may be invisible to the graph)`. `status` carries the repo-wide share as `unattributed calls N/M`. With `--json`, `callers`/`callees`/`impact` return `{ <command>: [rows], gaps: [gap rows] }`; `context` returns three gap lists — `gaps_in`, `gaps_out`, and `gaps` (the two merged with duplicates removed, since a wrapper-delegation call site can appear in both directions).

One thing the reports cannot fix: `callers`, `callees` and `impact` match a bare `name` as well as a `qname`, so `callers Get` merges the callers of *every* symbol named `Get`. Ask by `qname` (`callers store.Postgres.Get`) whenever a name is shared.

For a callback definition, asking by `qname` does not separate them either: a module-scope `beforeEach` on line 9 gives the qname `beforeEach@9` in every file that has one — 40 of them in this repo. The `file:line` printed beside each row is what identifies a hook, not its name.

> The Go `qname` format changed in schema version 2, schema version 3 added the struct-field-type table plus the field-selector call resolution above, schema version 5 made a call on the enclosing receiver (`s.M()`, `this.M()`, `self.M()`) receiver-qualified, and schema version 6 added the `dst_bare`/`lang`/`external` columns on `edges` and the `#embed` rows in `field_types` that the guards above rely on. Schema version 7 added the `guess` and `member` columns on `edges` — the marking the whole answer format now rests on — and receiver-qualified a Go method on a generic type. Version 8 added the return-type rows, version 9 the `decl` column that lets a C++ definition win over its own declaration, version 10 the TypeScript type rows (abstract classes, interface methods, class field types, `#extends` and `#alias:`), and version 11 (current) Go interface methods. A schema bump before 6 left an old `.pgraph/graph.db` in place and relied on the next `index`/`/p-graph:sync` to fully rebuild it. From schema 6 on, a new column can never be added to a table that already exists, so a bump instead **drops the graph tables as soon as the store is opened** — the graph is empty until the next query or sync rebuilds it. `status` reports this as `- rebuild pending (schema upgrade)` until then. Upgrading to this version therefore costs every existing user one full reindex.

Everything is stored in a local SQLite database at `.pgraph/graph.db` (gitignored, rebuildable at any time — it is never committed). The schema is append-friendly: a full index truncates and repopulates; an incremental index (`--changed`) diffs by commit SHA against the last indexed state, reparses only the changed files, and splices their symbols and edges back in. A stored `signature` is capped at 300 characters, which is why the database is small: it is a hint for a human reading a search hit, not a copy of the source. The longest one on caddy was 157,787 characters before the cap, and the database shrank from 100.8 MB to 10.5 MB with it.

The graph is purely local — there is no remote service, no MCP server, and no data leaves the machine.

## Measured benefit

[`docs/measured-benefit.md`](./docs/measured-benefit.md) runs the contest: the same structural
questions put to the same agent twice — once with nothing but `grep` and `Read`, once with p-graph
installed. **Fourteen public repos, 52 structural questions, 312 runs, three runs a side** — plus a
third arm on 6 Go, 9 TypeScript, 12 Python and 15 C++ questions against a language server, below. Every table here is printed by
`measure-agent.mjs --score`, not worked out by hand, so any of it can be regenerated.

### Every row, per language

Below are the 36 "who calls X" questions — the shape grep is best at — split by language and by how
big the repository is. The size line falls between leveldb (132 files, 9k call edges) and caddy
(326 files, 24k). **Read the accuracy rows here knowing that one truth list in this set was wrong
until August 2026** and its correction reversed the headline; the note under big-Go says which.

Big repositories:

**Go** — hugo 930 files / 55.5k call edges, caddy 326 / 23.6k · 5 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | **277 of 279** | **277 of 279** | **tie** |
| Invented | 0 | 0 | tie |
| Cost per question | $0.337 | **$0.240** | **−29%** |
| Time per question | 72 s | **45 s** | **−38%** |

This row used to read `226 of 228` both ways with grep inventing 51 — an artifact of one wrong
truth list. `caddy-handler-servehttp` really has **51** call sites, not 34, so grep never
invented anything there. Fixed, this row then read p-graph short by 48 of 279, because `callers`
on a Go interface method did not yet report the calls that reach it through an implementation.
That is fixed too — 28 August 2026, `callers caddyhttp.Handler.ServeHTTP` now names all 18 calls
in `metrics_test.go`, not 1 — and p-graph is back level with grep here. See
[the write-up](./docs/measured-benefit.md#why-go-moved) for both fixes, code and wording.

**TypeScript** — nest 1,728 / 38.3k · 5 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 177 of 177 | 177 of 177 | tie |
| Invented | 0 | 0 | tie |
| Cost per question | **$0.142** | $0.144 | +1% |
| Time per question | **20 s** | 27 s | +35% |

**C++** — rocksdb 1,454 / 318.7k · 3 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 114 of 114 | 114 of 114 | tie |
| Invented | 0 | 0 | tie |
| Cost per question | $0.124 | **$0.080** | **−35%** |
| Time per question | 21 s | **14 s** | **−33%** |

**Python** — django 3,036 / 195.1k · 3 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 108 of 108 | 108 of 108 | tie |
| Invented | 0 | 0 | tie |
| Cost per question | $0.094 | **$0.083** | **−12%** |
| Time per question | 17 s | **13 s** | **−24%** |

Small repositories:

**Go** — gin 99 / 9.2k · 2 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 105 of 108 | **108 of 108** | **p-graph** |
| Invented | 0 | 0 | tie |
| Cost per question | $0.170 | **$0.130** | **−24%** |
| Time per question | 45 s | **24 s** | **−48%** |

**TypeScript** — axios 240 / 14.3k, got 85 / 14.3k · 4 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | **282 of 282** | 254 of 282 | **grep** |
| Invented | 0 | 0 | tie |
| Cost per question | $0.194 | **$0.155** | **−20%** |
| Time per question | 33 s | **26 s** | **−21%** |

**C++** — spdlog 152 / 8.2k, leveldb 132 / 9.2k, re2 89 / 8.3k · 9 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 476 of 480 | **477 of 480** | **p-graph** |
| Invented | 0 | 0 | tie |
| Cost per question | **$0.301** | $0.358 | +19% |
| Time per question | 52 s | **51 s** | **−2%** |

**Python** — flask 83 / 3.9k, httpx 60 / 4.2k, requests 37 / 2.7k · 5 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 135 of 135 | 135 of 135 | tie |
| Invented | **0** | 14 | **grep** |
| Cost per question | $0.181 | **$0.136** | **−25%** |
| Time per question | 34 s | **22 s** | **−35%** |

**Read these tables for accuracy, not for size.** Size decides nothing here: p-graph comes back
cheaper on seven of the eight boxes above, big and small alike, roughly flat on the eighth
(TypeScript's nest questions), and dearer on only one — small C++ (leveldb, re2, spdlog), where one
question, `re2::Prog::size`, now costs $1.85 against grep's $1.11.

**The accuracy claim this section used to make has been withdrawn.** It said p-graph invents far
fewer call sites, 51 against 14. Both numbers came from truth lists, and one of them was wrong:
after the fix, **grep invents 0 across all 36 questions and p-graph invents 14**, and grep is ahead
on recall by 33 call sites of 1,683 (1,674 against 1,650) — not the 72-site gap once published here.
Most of that gap closed on its own once `callers` on a Go interface method started reporting the
calls that reach it through an implementation; see "Why Go moved" below. On this question shape —
"list every call site" — grep is still the more accurate of the two, but only just.

What survives on this shape is not accuracy: **16% fewer steps** (5.7 against 6.8, 2.7 standard
errors) and answers that say what they might be missing, 70 of 156 against 4 of 156.

### Following the calls

The size effect lives on the other question shape — "what breaks if I change X", "how does X reach Y".
There p-graph is **40% cheaper, 48% faster and 55% fewer steps** on the big repositories, and 22%
dearer on the small ones, measured on Go, C++ and Python alike.

**And that shape is where p-graph's accuracy advantage actually lives.** Over the 16 questions that
follow the calls, p-graph finds more and invents almost nothing:

| 16 questions that follow the calls | grep | p-graph |
|---|---|---|
| Call sites found | 180 of 216 | **187 of 216** |
| Invented | 32 | **1** |
| Steps per question | 9.4 | **7.6** |

On the big repositories the invented count is 26 against 0. That is the claim the list-shape tables
cannot support and this one can.

### Against a language server

grep is the floor. The question a user asks next is how the graph compares to the strong alternative,
so the same questions were put to an agent with the official language server plugins and the built-in
`LSP` tool — 6 Go, 9 TypeScript, 12 Python and 15 C++ questions, 3 runs a side, same clones, same
model.

| 4 list questions + 1 trap, caddy and hugo | grep | p-graph | gopls |
|---|---|---|---|
| Call sites found | 277 of 279 | **277 of 279** | **279 of 279** |
| Invented | 0 | 0 | 0 |
| Cost per question | $0.337 | **$0.240** | $0.357 |
| Time per question | 72 s | **45 s** | 78 s |
| Steps per question | 10.8 | **8.8** | 17.1 |
| `caddy-addnode-impact` — steps | 16.7 | 12.3 | 28.7 |

**This box used to read p-graph short by a third, and it no longer does.** `callers` on a Go
interface method now also reports the calls that run through an implementation of it — fixed
28 August 2026, see [the write-up](./docs/measured-benefit.md#why-go-moved). p-graph is level
with grep on call sites and still cheaper and faster than both. The language server still finds
2 more of 279 and is still the most expensive in steps: it pays for its round trips because the
`LSP` API is addressed by file, line and character — a list of N call sites costs N calls, where
a graph query costs one.

Two things a language server cannot do, and they decide when the graph still wins: it needs the
project to **build** (resolved modules, `npm install`, a C++ `compile_commands.json`), and it walks a
call chain one request per hop — 28.7 steps against p-graph's 12.3 on the transitive question.

**On TypeScript the same arm came last, and that changes the advice.** Nine questions on nest, got
and axios, same setup, `typescript-language-server`:

| 9 list questions, nest · got · axios | grep | p-graph | tsserver |
|---|---|---|---|
| Call sites found | **459 of 459** | 431 of 459 | 413 of 459 |
| Invented | 0 | 0 | 0 |
| Cost per question | **$0.166** | $0.170 | $0.259 |
| Steps per question | 5.8 | **4.4** | 11.4 |

Forty of the 46 missing sites are in nest, and nest's own configuration explains both misses — each
one reproduced from the server directly, with no agent in between. `PipesContextCreator.create` has
four callers and tsserver names two: nest ships nine per-package `tsconfig.json` files with
`"include": []`, so a sibling package's import of `@nestjs/core/pipes` resolves to the published copy
in `node_modules`, not to the source. `ClassSerializerInterceptor.serialize` has 13 callers and
tsserver names one: the root `tsconfig.json` excludes `**/*.spec.ts`, so the 12 test callers are
outside the program. Neither miss came with a warning.

**On Python the server is the cheapest of the three per call, and its answer is only as wide as the
files it has open.** Twelve questions on requests, flask, httpx and django:

| 8 list questions | grep | p-graph | pyright |
|---|---|---|---|
| Call sites found | **243 of 243** | **243 of 243** | 233 of 243 |
| Invented | 0 | 14 | **0** |
| Cost per question | **$0.148** | $0.149 | $0.233 |
| Steps per question | **4.0** | 4.1 | 10.6 |

One `findReferences` returns the whole list here, where Go cost about one call per site — three django
runs answered in two turns for $0.04 to $0.08. Every one of the ten missing sites is a single run of
three, and the cause was reproduced from the server: asked at the definition of httpx's `Cookies.set`
pyright names its 3 same-file callers, asked at a call in the test file it names the 6 others, and
with both files open it names all 10 — exactly the truth. An editor keeps many files open; an agent
sees as much as it read first.

**On C++ it is the worst of the three, and this was the language it was expected to win.** Fifteen
questions on leveldb, re2, spdlog and rocksdb:

| 12 list questions | grep | p-graph | clangd |
|---|---|---|---|
| Call sites found | 590 of 594 | **591 of 594** | 517 of 594 |
| Invented | 0 | 0 | 0 |
| Cost per question | $0.257 | **$0.261** | $0.288 |
| Steps per question | 8.3 | **7.0** | 13.5 |

Two mechanisms, both reproduced from the server. A file in no build target does not exist to clangd:
three leveldb test files are commented out in leveldb's own `CMakeLists.txt`, re2's `app/_re2.cc` is
a Python extension, and rocksdb's JNI test needs a JDK — 7 sites, the same in every run. And a
virtual method splits its callers: `spdlog::sinks::sink::log` has 29 call sites, where the base
declaration answers 3 references and the `base_sink` override answers 30. Neither is the answer to
"who calls this method". p-graph, matching on the name, returned 87 of 87.

Getting clangd to answer at all was the expensive part. A short Windows path in
`compile_commands.json` stopped its background index before it started — twenty minutes, zero shards,
no log line — and that is the third time the 8.3 path has broken this study. Even with long paths, the
first plateau is not the finish: at 128 index shards clangd named 6 callers of `Status::ToString`, at
151 it named 20, at 230 it named 45, and a text search finds 42. It never said the index was
incomplete.

**Withdrawn.** This section used to say "for Go, reach for the language server first" — the server
found every call site where p-graph was short by a third. Fixed, p-graph is level with the server
on Go (277 of 279 against 279) at a third less cost and half the steps, and over all four languages
together p-graph now beats the server on recall too: 1,542 call sites of 1,575 against the server's
1,442. The server wins no language outright any more. Weighing recall, invented rows, cost and
steps: **Go and C++
favour p-graph, Python and TypeScript favour grep** — the server is not the first reach for any of
them. Know what bounds its answer regardless: TypeScript by what `tsconfig.json` covers, Python by
which files are open, C++ by the compile database and by one question per override for a virtual
method. Reach for p-graph for "what breaks if I change X" on a big repository, for any repository
that does not build, for any question whose callers live outside the type program, and for a virtual
or duck-typed call, where matching on the name beats resolving the type.

Read this arm with its limits in view: 42 questions, four languages, one machine, 3 runs a side.
Two of the study's own truth lists turned out to be short, found because this arm named real code they
were missing. And 17 of the first 18 runs had to be thrown away because `gopls` was silently
answering nothing at all.
All of it is written up in
[the plan](./docs/superpowers/plans/2026-08-14-p-graph-lsp-arm.md).

**Three runs a side is not enough to read the accuracy rows closely.** Re-running only the p-graph arm
after a C++-only change moved two languages the change cannot touch: axios lost 24 of its 75 call
sites and requests invented 14 where it had invented none. The graph's own answers were checked and
were unchanged and correct, so that swing is the agent writing its answer up differently from one run
to the next. The published noise floor covers cost, time and steps — it has never covered found and
invented.

Every fix and every pass that got here, including the round-by-round history before the fourteenth
and thirteenth repositories were added, is in [docs/measured-benefit.md](./docs/measured-benefit.md).

## Design

Design specs and implementation plans for this plugin live under [`docs/`](./docs/).

## Validate

```bash
claude plugin validate .
```
