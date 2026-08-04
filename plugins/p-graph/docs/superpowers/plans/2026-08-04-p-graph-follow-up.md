# p-graph: what is left after the trustworthy-answers branch

Written when `feature/p-graph-trustworthy-answers` shipped as p-graph **1.0.0**
(monorepo tag `v6.0.0`). Nothing here is implemented. Nothing here is a
regression from that branch — every item is either a known limit of what
shipped or a defect the branch found and chose not to fix.

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
| False rows among resolved | 42.9% | 9.5% |
| False rows among **certain** | — | **0 of 1,352** in that set; item 2 below is a shape the set did not contain |
| Silent misses | the original complaint | 2 of 1,724, both pre-existing |
| `impact` on hugo | 15,555 ms | 399 ms |
| caddy database | 105.6 MB | 10.5 MB |

---

## Ordered by how much wrongness each one still causes

### 1. A receiver typed from a function's return value

`x := reflect.ValueOf(...)`, `buf := bp.GetBuffer()`. The variable has no
recorded type, so the call resolves by unique bare name — a guess. **This is the
largest remaining source of wrong rows.** `collections.Namespace.Index` prints 26
rows where `gopls` says 3, and all 25 false ones are this shape.

Reading a called repo function's declared return type would close most of it.

### 2. A bare-name call in JavaScript or TypeScript is matched across files, and marked certain

A top-level JS/TS function's qname is just its name (`walk`), not a
module-qualified one, so Pass A — the exact-qname pass, which marks its matches
**certain** — accepts any bare call written `walk(...)` anywhere in the repo. The
real target can be a local function of the same name in the calling scope.

Measured on p-graph's own source as a repo (78 files, 180 symbols, real CLI):

| | |
|---|---|
| certain resolved calls | 154 |
| false among them | **2** |
| the false pair | `attachReadHelpers` -> `walk` (`lib/index/build.mjs:24`) |
| the real target | `attachReadHelpers.walk` (`local-sqlite.mjs:910`), in the same file |

Consequences seen in the CLI output: `callers walk` lists 3 certain callers, one
of which is false; `impact isIgnored` gains four symbols (`openStore`,
`attachReadHelpers`, `openReadOnly`, `resolveDestination`) that have nothing to do
with `isIgnored`, because `impact` follows certain edges and this one says it is
certain.

**This is the one known exception to "no certain row was false".** That figure
(0 of 1,352) was measured over Go, TypeScript, Python and C++ call sites, but the
sample held no shadowed top-level name, so the shape never appeared. It ranks
second here because a false CERTAIN row is worse per row than a false guess, even
though it needs a duplicated top-level name to happen at all.

Go is not affected: its call targets are package-qualified, so a local `walk`
cannot collide with `build.walk`. A C++ function in the global namespace has the
same bare qname and probably the same exposure — not measured.

Fix direction: for a bare-name call in a lexically-scoped language, prefer a
definition in the same scope or file, and do not call a cross-file bare-name match
certain unless that file imports the name.

### 3. A type table for TypeScript and Python

A real method with a real owner, called on an untyped value, still resolves
wrongly: got's `setHeader` 89 false rows, `RequestsCookieJar.set` 22, `.update`
15. The owner rule that shipped cannot help here, because the owner is genuinely
a class. Only a recorded type can.

### 4. A C++ type table

C++ is usable for calls written `Class::method(...)` — 11 of 11 correct on a real
leveldb symbol. A member call on a value is about 40% of C++ calls and still
cannot resolve.

### 5. Interface dispatch

There are no `implements` edges. A call through an interface with one
implementation resolves to it as a guess; with two or more it becomes a gap. The
honest answer is "these N types could receive this call", and the graph cannot
say that yet.

### 6. The read-only fallback dies on a pre-schema-6 database

`callers`, `callees`, `impact` and `context` exit 3 with
`no such column: e.dst_bare`, because the gap-report statements name columns the
old schema lacks. This hits in the one situation the fallback exists for: a
filesystem that can never be migrated. `search`, `node`, `files`, `explore` and
`status` still work. Make those four degrade instead of dying.

### 7. `impactSkippedGuesses` counts edges `impact` would never have followed

It omits the `src_id IS NOT NULL` that `impact` requires, so a guessed
module-scope call is reported twice — once as a skipped guess, once as a
`no-caller` gap.

### 8. A missing argument prints a SQLite error

`callers`, `callees`, `impact`, `context`, `node` and `trace` print
`pgraph: Provided value cannot be bound to SQLite parameter 1.` and exit 3.
`search` has the right check; copy it.

### 9. TypeScript call-argument function bodies are not definitions

`describe` / `it` callbacks, so 394 of nest's 1,727 files produce no symbols, and
a majority of resolved edges there have no source symbol. They do surface, as
`outside any indexed symbol` gap rows — but they have no caller to name.

### 10. Two repo packages sharing a base name collapse into one qname space

So a call can resolve to the wrong package's symbol. The `count(DISTINCT ft.type)
= 1` guard in Pass F is what stops that from becoming a *certain* wrong row today
(`receiver-types.test.ts` covers it), but the collapse itself is still there.

### 11. `gitChangedFiles` cannot see a file created and deleted without a commit

So a stale row survives until the next `--full`.

### 12. The evidence for "0 of 1,352 certain rows false" is not in the repo

It lives in `.superpowers/sdd/task-9-report.md`, which is git-ignored scratch on
one machine. It is this work's strongest claim and nobody can audit it from the
repo. **Move that table next to `2026-08-01-p-graph-correct-answers-results.md`
before the scratch folder is cleaned** — `git clean -fdx` destroys it and there
is no second copy.

### 13. Smaller, all recorded in `.superpowers/sdd/progress.md`

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
