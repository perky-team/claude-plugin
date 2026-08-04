# p-graph: what is left after the trustworthy-answers branch

Written when `feature/p-graph-trustworthy-answers` shipped as p-graph **1.0.0**
(monorepo tag `v6.0.0`). The numbered list is open work — none of it is
implemented, and none of it is a regression from that branch: every item is
either a known limit of what shipped or a defect the branch found and chose not
to fix. Items fixed after the list was written are moved to the section at the
bottom, with their measurements — the numbered list only ever holds open work.

Two plans landed before this list, both with measured results next to them:

| File | What it did |
|---|---|
| `2026-07-31-p-graph-trustworthy-answers.md` (+ `-results.md`) | Stop the graph hiding what it could not resolve. |
| `2026-08-01-p-graph-correct-answers.md` (+ `-results.md`) | Make the answers right, by giving the resolver the receiver's type. |
| `2026-08-04-p-graph-ship-handoff.md` | The four steps that closed the branch. This file is step 4 of it. |

Where the graph stands, measured on gohugoio/hugo, nestjs/nest, pallets/flask,
caddyserver/caddy, google/leveldb, sindresorhus/got and psf/requests, with
`gopls` as ground truth where it applies:

| | Before | Now |
|---|---|---|
| False rows among resolved | 42.9% | 6.9% |
| False rows among **certain** | — | **0 of 1,391**; one shape the set did not contain was found later and fixed, see below |
| Silent misses | the original complaint | 2 of 1,724, both pre-existing |
| `impact` on hugo | 15,555 ms | 399 ms |
| caddy database | 105.6 MB | 10.5 MB |

---

## Ordered by how much wrongness each one still causes

### 1. A type table for TypeScript

**Now the single largest source of false rows: got's `setHeader`, 89 of them.**
Measured shape: every one is `response.setHeader(...)` where `response` is an
UNANNOTATED callback parameter, as in
`server.all('/x', async (request, response) => ...)`. Its type lives in a library's
declaration file, so there is nothing in the repo to read. Two independent moves:

- **read TypeScript annotations** (`function f(c: Conn)`, `const c: Conn = ...`,
  `foo(): Conn`) into the same table Go and Python now use. That adds certainty
  wherever the source states a type.
- **refuse a member call on an unannotated parameter, in `.ts` files only.** Under
  `noImplicitAny` an unannotated parameter means its type is inferred from a library
  signature, which is exactly the got case. This is the move that removes the 89
  rows, and it must not apply to `.js`, where nothing is annotated.

Python's half of this item is done - see the fixed section below.

### 2. A C++ type table

C++ is usable for calls written `Class::method(...)` — 11 of 11 correct on a real
leveldb symbol. A member call on a value is about 40% of C++ calls and still
cannot resolve.

### 3. Interface dispatch

There are no `implements` edges. A call through an interface with one
implementation resolves to it as a guess; with two or more it becomes a gap. The
honest answer is "these N types could receive this call", and the graph cannot
say that yet.

### 4. TypeScript call-argument function bodies are not definitions

`describe` / `it` callbacks, so 394 of nest's 1,727 files produce no symbols, and
a majority of resolved edges there have no source symbol. They do surface, as
`outside any indexed symbol` gap rows — but they have no caller to name.

### 5. Two repo packages sharing a base name collapse into one qname space

So a call can resolve to the wrong package's symbol. The `count(DISTINCT ft.type)
= 1` guard in Pass F is what stops that from becoming a *certain* wrong row today
(`receiver-types.test.ts` covers it), but the collapse itself is still there.

### 6. `gitChangedFiles` cannot see a file created and deleted without a commit

So a stale row survives until the next `--full`.

### 7. Smaller, all recorded in `.superpowers/sdd/progress.md`

- An assertion in `alias-resolution.test.ts` that no longer tells the two
  variable-key shapes apart.
- Duplicated test coverage across four pairs of files.
- 126 duplicate `leveldb` namespace nodes.
- A macro-broken C++ class body can make a class look like a caller of its own
  method (17 certain edges in leveldb, pre-existing).
- Python extraction is 1.6× slower than before, entirely from the new
  local-variable captures. The cheap fix — run that query only on files that
  have a module-qualified member call — needs an `engine.mjs` API change.
- A build-tagged Go variable can never resolve. The index reads every platform's
  file, so `var store = &Postgres{}` in one file and `var store = &Memory{}` in
  another give one name two types, and Pass F refuses the key. The call becomes a
  gap, which is the honest answer, but a per-platform answer would be better.
  Found while writing the test that now locks that refusal in.

---

## Fixed after this list was written

**A bare-name call matched across files and called certain.** A top-level
function in JS, TypeScript, Python or C++ has a bare qname (`walk`), so the
exact-qname pass accepted a plain `walk(...)` written anywhere in the repo and
marked the match certain. Found by running the shipped CLI over p-graph's own
source: `walk(true)` inside `attachReadHelpers` linked to `build.mjs`'s `walk`
while the real target sat eleven lines above it in the same file.

Fixed by resolving lexical scope first: a definition the call site can see wins.
Nested definitions are visible only inside the scope that holds them, so a call in
a sibling function keeps the answer it had. A call written on a value (`o.walk()`)
and a candidate owned by a class, struct, interface or namespace are both left
alone — a bare call is not a call on the enclosing class.

Measured, old code vs new, over the same frozen trees:

| | p-graph's own source (78 files) | nestjs/nest (1,728 files) |
|---|---|---|
| call sites unchanged | 4,044 | 37,890 |
| newly resolved (was nothing) | 501 | 334 |
| retargeted to the right symbol | 2 | 1 |
| lost an answer | 0 | 0 |
| guess -> certain | 59 | 39 |
| certain -> guess | 0 | 0 |
| full index time | 1.64 s (was 1.72 s) | 50.2 s (was 49.5 s), inside the noise |

nest's one retargeted row is ground truth from the author: `injector.ts` declares a
local `isOptionalFactoryDependency` with the comment "Same as the internal utility
function `isOptionalFactoryDependency` from `@nestjs/common`", and the old code
linked the call to that other copy, which the file never imports.


**The row-level evidence was outside the repo.** The table behind "no certain row
was false" lived in a git-ignored working folder on one machine. All 22 symbols were
re-measured on fresh clones with the shipped code, and the audit of every certain
row is now in `2026-08-04-p-graph-remeasured.md`: 1,734 resolved rows (same as
published), 1,353 certain, **0 false** — 1,345 checked mechanically, 8 read by hand.




**A Python name bound to a constructor call** (half of the old item 2). `jar =
RequestsCookieJar()` and `close_server = threading.Event()` are one shape to a
parser. Python bindings are now keyed by scope, a member call on such a name carries
that key, and the constructor is recorded under it, so the resolver either finds the
repo class and answers certainly or finds nothing and refuses.

| psf/requests symbol | before | after |
|---|---|---|
| `RequestsCookieJar.set` | 38 rows, 1 certain, 22 false | **22 rows, 16 certain - every one a real `jar.set(...)`** |
| `RequestsCookieJar.update` | 16 rows, 0 certain | **11 rows, 1 certain** |
| `get` | 84 rows | **104 rows, all certain** - `s = requests.Session()` types `s` |
| the 22 measured symbols | 1,707 resolved / 1,355 certain | **1,706 / 1,391** |

The 16 refused `set` call sites are all `threading.Event()` objects, and all appear in
the gap report. Two shapes are deliberately untouched: a receiver written as an
attribute (`self.ready.set()`), and a name bound to a plain function call rather than
a constructor.

**A receiver typed from a function's return value** (the old item 1, the largest
remaining source of false rows). `b := hugolib.Test(t, files)` then
`b.AssertFileContent(...)`: nothing at the call site names a type, so the bare name
answered it. Extraction now records the callee under the variable's key
(`#ret:hugolib.Test`) and every function's declared result under `<qname>#ret`, and
a new resolver pass follows one to the other. Both are facts read from the source,
so the rows are certain.

| | before | after |
|---|---|---|
| hugo: certain call edges | 12,569 | **15,681** |
| hugo: guessed call edges | 5,002 | **2,030** |
| caddy: certain / guessed | 6,071 / 1,610 | **6,496 / 1,207** |
| `collections.Namespace.Index` rows (gopls: 2 real sites) | 37 edges, 0 certain | **13 edges, 2 certain — and those 2 are the real ones** |
| `byteCountFlexiWriter.WriteRune` (1 real site, already a gap row) | 3 edges, all false | **0 edges** |
| the 22 measured symbols | 1,734 resolved / 165 false | **1,707 / 138** |

The other half of the same fact does the pruning: when the callee is outside the
repo (`x := reflect.ValueOf(v)`) there is no result to read, and the recorded marker
tells Pass B to refuse instead of guessing. That is where the 27 false rows went.

Costs, measured and disclosed: three correct rows on hugo were lost because their
callee is a closure held in a variable (`runTest := func(...) *T`), which is not a
function declaration and so has no recorded result — all three are in the gap
report. A chain through a method call (`t := c.Begin()`) is not followed either: the
receiver's own type is the question being asked.

**Three defects that broke a command or a number** (the old items 5, 6 and 7):

- A forgotten argument printed `pgraph: Provided value cannot be bound to SQLite
  parameter 1.` and exited 3. `callers`, `callees`, `impact`, `context` and `node`
  now say `<command> needs a symbol`, `trace` says it needs two, and all exit 1 —
  the same shape `search` always had.
- `impactSkippedGuesses` counted edges with no source symbol, which `impact` never
  walks, so a module-scope call was reported twice: once as a refused path, once as
  a `no-caller` gap row. It now counts only what the walk could have followed.
- The read-only fallback died on any pre-schema-6 database with
  `no such column: e.dst_bare`, taking `callers`, `callees`, `impact` and `context`
  down in the one situation that fallback exists for — a filesystem that can never
  be migrated. Those four now answer the rows they have and say the gap report is
  unavailable, in text and as `gaps_unavailable` in `--json`. An empty gap list is
  not the same claim as "no gaps", so it is never silent.

**Not covered, and not measured:** C++ has no nested functions, and a lambda
assigned to a variable (`auto walk = [](int b) { return b; };`) is not indexed as a
definition — so a call to it has no same-file candidate to prefer, and it still
resolves to a same-named global function elsewhere. Indexing C++ lambdas would
close that.

---

## Known costs of what shipped, so they are not rediscovered as bugs

- A word past the 300-character signature cap is no longer findable with
  `search`. Searching by name or qname is unaffected. The cap took caddy's
  database from 105.6 MB to 10.5 MB.
- A C++ pure virtual declared in a header with no in-repo definition is not in
  the graph. Indexing declarations was tried and measured: it cost 620 resolved
  edges and made `store.node` a coin flip between a definition and an edgeless
  declaration.
- Some real edges are refused on purpose, where the receiver's type is known to
  live outside the repo. Every one of them appears in the gap report; none went
  silent.
- Every existing user reindexes once. `SCHEMA_VERSION` went 4 → 7, and the first
  command to open an old database erases the graph. A query run with the refresh
  skipped (`--stale-ok` or `PGRAPH_AUTOREFRESH=0`) then exits 4 with
  `{"error":"graph_erased"}` instead of an empty answer.
