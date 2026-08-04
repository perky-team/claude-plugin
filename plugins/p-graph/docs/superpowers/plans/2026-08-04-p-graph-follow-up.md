# p-graph: what is left after the trustworthy-answers branch

Written when `feature/p-graph-trustworthy-answers` shipped as p-graph **1.0.0**
(monorepo tag `v6.0.0`). The numbered list is open work — none of it is
implemented, and none of it is a regression from that branch: every item is
either a known limit of what shipped or a defect the branch found and chose not
to fix. One item was fixed after the list was written; it has its own section at
the bottom, with the measurements.

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
| False rows among **certain** | — | **0 of 1,352**; one shape the set did not contain was found later and fixed, see below |
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

### 2. A type table for TypeScript and Python

A real method with a real owner, called on an untyped value, still resolves
wrongly: got's `setHeader` 89 false rows, `RequestsCookieJar.set` 22, `.update`
15. The owner rule that shipped cannot help here, because the owner is genuinely
a class. Only a recorded type can.

### 3. A C++ type table

C++ is usable for calls written `Class::method(...)` — 11 of 11 correct on a real
leveldb symbol. A member call on a value is about 40% of C++ calls and still
cannot resolve.

### 4. Interface dispatch

There are no `implements` edges. A call through an interface with one
implementation resolves to it as a guess; with two or more it becomes a gap. The
honest answer is "these N types could receive this call", and the graph cannot
say that yet.

### 5. The read-only fallback dies on a pre-schema-6 database

`callers`, `callees`, `impact` and `context` exit 3 with
`no such column: e.dst_bare`, because the gap-report statements name columns the
old schema lacks. This hits in the one situation the fallback exists for: a
filesystem that can never be migrated. `search`, `node`, `files`, `explore` and
`status` still work. Make those four degrade instead of dying.

### 6. `impactSkippedGuesses` counts edges `impact` would never have followed

It omits the `src_id IS NOT NULL` that `impact` requires, so a guessed
module-scope call is reported twice — once as a skipped guess, once as a
`no-caller` gap.

### 7. A missing argument prints a SQLite error

`callers`, `callees`, `impact`, `context`, `node` and `trace` print
`pgraph: Provided value cannot be bound to SQLite parameter 1.` and exit 3.
`search` has the right check; copy it.

### 8. TypeScript call-argument function bodies are not definitions

`describe` / `it` callbacks, so 394 of nest's 1,727 files produce no symbols, and
a majority of resolved edges there have no source symbol. They do surface, as
`outside any indexed symbol` gap rows — but they have no caller to name.

### 9. Two repo packages sharing a base name collapse into one qname space

So a call can resolve to the wrong package's symbol. The `count(DISTINCT ft.type)
= 1` guard in Pass F is what stops that from becoming a *certain* wrong row today
(`receiver-types.test.ts` covers it), but the collapse itself is still there.

### 10. `gitChangedFiles` cannot see a file created and deleted without a commit

So a stale row survives until the next `--full`.

### 11. The evidence for "0 of 1,352 certain rows false" is not in the repo

It lives in `.superpowers/sdd/task-9-report.md`, which is git-ignored scratch on
one machine. It is this work's strongest claim and nobody can audit it from the
repo. **Move that table next to `2026-08-01-p-graph-correct-answers-results.md`
before the scratch folder is cleaned** — `git clean -fdx` destroys it and there
is no second copy.

### 12. Smaller, all recorded in `.superpowers/sdd/progress.md`

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
