# Results: giving TypeScript call sites a caller

Plan: `2026-08-05-p-graph-ts-callback-defs.md`. Handoff: `2026-08-05-p-graph-ts-callers-handoff.md`.
Branch `feature/p-graph-ts-callback-defs`, base `9aea17f` (main at v6.2.0, p-graph 1.2.0).

Every number below was measured. Where a "before" column appears, both columns come
from indexing the SAME tree with two parser versions, one after the other.

## What changed

A function passed as a call argument is now indexed as a definition — but only when
no named definition encloses it. It is named after the call beside it: `it('case', …)`
becomes `it:case`, and a call with no string first argument becomes `beforeEach@42`.

Two rules carry the whole design, and both were forced by measurement:

1. **A callback inside a named function is NOT indexed.** An inline
   `xs.map(x => target() + x)` inside `named` is already attributed to `named`, which
   is right and useful. Indexing it would replace that caller with an anonymous arrow
   and `impact` would stop there, because nothing calls an arrow passed as a value.
2. **A callback does not qualify a declaration written inside it.** It qualifies a
   nested callback, so a test reads `describe:suite.it:case`, but a `const helper`
   inside a `describe` keeps the bare qname it always had. See "The defect this
   found" below — the first version got this wrong and cost three false certain rows.

## The probe from the handoff

Same fixture, real CLI, before and after:

`pgraph callers target`, before — copied from the terminal, not retyped:

```
function named  probe.ts:2  export function named(xs: number[]) {
⚠ 1 call site missing from this answer:
    probe.ts:6  outside any indexed symbol -> target
  Confirm with a text search before treating this answer as complete.
```

And after:

```
function describe:suite.it:case  probe.ts:6  it('case', () => { target(); });    // call-argument arrow at module scope
function named  probe.ts:2  export function named(xs: number[]) {
```

Line 3's inline arrow still attributes to `named`. Line 6 has a caller. No banner.

## The headline: nest `TestingModule.createNestApplication`

The handoff predicted this exactly.

| | before | after |
|---|---|---|
| caller rows | 6 | **189** |
| gap rows | 184, all `no-caller` | **0** |

190 call sites reach the symbol; 189 distinct callers, because two calls from one test
callback are one caller. The rows now read as tests and hooks — two real ones, each on
one line:

```
function describe:Get URL (Express Application).it:should be able to get the IPv6 address  integration/nest-application/get-url/e2e/express.spec.ts:22  it('should be able to get the IPv6 address', async () => {
function describe:Media Type Versioning (fastify).describe:with the global default version: "1".before@348  integration/versioning/e2e/media-type-versioning-fastify.spec.ts:348  before(async () => {
```

`nest isUndefined`: 55 callers / 2 gap rows → 57 callers / 0 gap rows.

## Repo-wide, three repos

Call sites with **no caller** — the number this work exists to move:

| repo | files | before | after |
|---|---|---|---|
| this repo | 380 | 20,124 / 28,347 (**71%**) | 1,354 (**4.8%**) |
| sindresorhus/got | 85 | 11,454 / 14,329 (**79.9%**) | 1,598 (**11.2%**) |
| nestjs/nest | 1,728 | 28,448 / 38,315 (**74.2%**) | 1,409 (**3.7%**) |

Everything else, same three repos:

| metric | this repo | got | nest |
|---|---|---|---|
| nodes | 1,545 → 4,749 | 1,107 → 3,504 | 5,804 → 12,919 |
| of them callback definitions | 3,204 | 2,397 | 7,115 |
| files producing no symbols | 89 → **3** | 15 → **3** | 393 → **176** |
| resolved calls | 4,680 → 4,714 | 1,809 → 1,843 | 8,624 → 8,666 |
| guessed among resolved | 206 → **206** | 227 → **227** | 1,396 → **1,396** |
| resolved but callerless | 2,427 → 138 | 983 → 14 | 4,880 → 459 |
| graph.db | 8.0 → 11.3 MiB | 4.3 → 6.4 MiB | 17.0 → 23.1 MiB |

Not one guessed row was added on any repo. Every gained edge is certain, and every one
of them was checked (next section).

## Nothing moved that already had an answer

Two checks, run on all three repos.

**Node identity.** A node is matched by its content-addressed id.

| | this repo | got | nest |
|---|---|---|---|
| nodes that disappeared | 0 | 0 | 0 |
| nodes that kept an id but changed name, qname, kind, lang, file or line | **0** | **0** | **0** |
| nodes added that are not a callback | **0** | **0** | **0** |
| nodes whose `container_id` changed | 86 | 356 | 665 |

The `container_id` changes are the point: a declaration written inside a callback now
has an owner where it had none. Nothing else about it moved.

**Resolved call edges.** A call site is matched by file + line + target name; a target's
identity is its file + start line, so a qname gaining a prefix is not counted as a
retarget.

| | this repo | got | nest |
|---|---|---|---|
| gained | 34 | 34 | 47 |
| lost | 0 | 0 | 5 |
| target moved | **0** | **0** | **0** |
| certainty moved | **0** | **0** | **0** |
| gained edges whose target is in another file | **0** | **0** | **0** |

Every gain is Pass L reading lexical scope inside one file, and every gain is a real
one. The shape is always the same: two tests in one file each declare a helper of the
same name. Before, both helpers sat at "top level" as far as the graph could tell, so
Pass L saw two candidates in one scope and refused. Now each helper belongs to its own
test, and each call reaches the helper of its own test. Example — `backoff.test.ts`
declares `at` twice, once inside `it('doubles from one minute and stops at the cap')`
and once inside `describe('parseResetTime — free text to a timestamp')`; those two
account for 22 of this repo's 34 gains.

**The 5 lost rows on nest are 5 false rows removed, read one by one.** All five are
`callback()` in `server-grpc.spec.ts`, written as `on: (event, callback) => callback()`
— the arrow's own parameter. The graph used to link all five, CERTAINLY, to a
`const callback = () => {}` declared 400 lines away inside a different `describe`.
Giving that constant a real scope is what makes Pass L refuse it.

## Precision did not move

`node plugins/p-graph/scripts/measure.mjs --no-clone` — 7 pinned repos, 22 published
symbols. Run twice: once with this branch, once with the pre-change code.

| | pre-change code | this branch |
|---|---|---|
| resolved rows | 1,620 | 1,620 |
| certain | 1,411 | 1,411 |
| guessed | 209 | 209 |
| certain rows with a mechanical reason | 1,403 | 1,403 |
| certain rows read by hand and correct | 8 | 8 |
| exit code | 0 | 0 |

Identical, symbol by symbol. Only the **gap-row** column moved, and only downwards:
nest `createNestApplication` 184 → 0, `isUndefined` 2 → 0, `isObject` 6 → 0, got
`setHeader` 88 → 87.

One note for the record: the handoff publishes 1,619 resolved / 208 guessed. A fresh
run of the **pre-change** code gives 1,620 / 209, so that one row predates this work.

## What did NOT improve

- **got `end` (826 gap rows) and `exec` (92) are unchanged.** Their gaps are
  `ambiguous` and `external` — calls whose TARGET the graph refuses to name. This work
  fixes the caller side. `setHeader` moved by exactly its one `no-caller` row: 88 → 87.
- **In this repo, a test still does not reach the function it tests.** The tests are
  `.ts` and the sources are `.mjs`, and every resolver pass requires the same language
  on both ends. `impact computeActionable` returns 3 symbols before and after. What
  changed is that the gap row now names the test (`src_qname` is filled) instead of
  reading `outside any indexed symbol`. A repo whose tests and sources share a
  language — nest — gets the full effect.
- **A function inside an object literal passed as an argument is still not indexed.**
  `foo({ onDone: () => target() })` — the arrow's parent is a pair, not an argument
  list. Calls inside it still have no caller.
- **A callback inside a named function is deliberately not indexed.** That is rule 1,
  not a gap.
- 1,354 call sites in this repo still have no caller (4.8%). They are module-scope
  calls and object-literal callbacks.

## Costs, all measured

**Full index is slower.** nest, three alternating runs of each version, medians:

| | before | after |
|---|---|---|
| full index | 109.3 s | **128.1 s** (+17%) |
| incremental after one edit | 0.87 s | **0.88 s** |
| `callers` query | 0.25 s | 0.22 s |
| `impact` query | 0.23 s | 0.21 s |

The day-to-day path — an incremental refresh — is unchanged, and so are queries. Only
the one-off full index pays. Of the +18.8 s, extraction accounts for +6.5 s (33.9 →
40.5 s of `extract()` across nest's 1,728 files); the rest is writing and full-text
indexing 2.2× the nodes.

There is no pathological file. Per-file `extract()` on nest: before, every file bar one
first-run outlier came in at 49 ms or less; after, the slowest is `injector.ts` at 59 ms
with 62 definitions, and the biggest test file (`instance-wrapper.spec.ts`, 190
definitions, 1,052 lines) takes 54 ms. The cost is spread, not concentrated.

nest still has 176 files producing no symbols, down from 393. Those are files whose
whole content is inside an object literal or a bare module-level expression.

**The database grows** by 36-41% (table above), because it holds 2.2-3.2× the nodes.

**`search` did not become noisy.** The real definition still comes first:

```
$ pgraph search openStore
function openStore  plugins/p-graph/tools/lib/destinations/local-sqlite.mjs:147
method   openStore.getMeta  …
…
function describe:store read.beforeEach@16  plugins/p-graph/tools/__tests__/store-read.test.ts:16
```

```
$ pgraph search computeActionable
function computeActionable  plugins/p-graph/tools/lib/freshness.mjs:24
function describe:computeActionable  plugins/p-graph/tools/__tests__/freshness.test.ts:4
function describe:computeActionable.it:keeps only source files pgraph indexes, …
```

One callback row of eleven for `openStore`, and for `computeActionable` the callback
rows are that symbol's own tests — which is useful, not noise.

## The defect this found, and how

The first version let a callback qualify everything inside it. That looked harmless and
the whole suite stayed green. Then the before/after edge diff on this repo showed
**37 gains where 34 were expected**, and 3 of them had a target in another file.

`io.test.ts` calls `readJobState`, which it imports from `lib/io.mjs`. Three TypeScript
nodes had carried the bare qname `readJobState`, so Pass A honestly refused — a qname
must be unique for Pass A to call a match certain. Moving one of them under its
`describe` left exactly one, the name looked unique, and three call sites linked
CERTAINLY to an unrelated test helper in `cli-guard-e2e.test.ts`.

So: **this feature must not move any qname.** A callback now qualifies a nested
callback only. The regression test is a four-file fixture that reproduces the exact
shape, and it fails against the naive rule.

Worth stating plainly: the suite passed with the defect in place. What caught it was
diffing every resolved edge against the same tree, and reading the ones that moved.

## Tests

| | files | passed | skipped |
|---|---|---|---|
| p-graph alone (Windows) | 60 | 300 | 0 |
| whole repo, Windows | 253 | 2,392 | 23 |
| whole repo, WSL Ubuntu 24.04, Node 24.19.0 | 253 | 2,400 | 15 |

Thirteen new tests in `ts-callback-defs.test.ts`. Every rule is mutation-verified:
removing the enclosing-definition filter fails the trap tests, restoring the naive
qname rule fails the two qname tests, and the naive character cut fails the surrogate
test. No existing test needed its expectation changed.

---

# The quality pass

Run after the work above was already committed, to find what the feature tests and
the before/after diffs could not. Four rounds, each hunting a named failure rather
than exercising a feature. It found four things: two defects in this work (both
fixed), and two pre-existing defects that had never been measured.

## Round 1 — invariants

| # | Hunted | Result |
|---|---|---|
| 1.2 | two full indexes of one tree disagree | **PASS** on got and nest — every node id and every call edge identical |
| 1.1a | an incremental index after an edit disagrees with a full one | **PASS** on got and nest, identical |
| 1.1b | an incremental index after a new file disagrees with a full one | **PASS** on got and nest, identical |
| 1.1d | a committed add and delete leaves anything behind | **PASS** — after delete + commit + index the graph is byte-identical to the clean baseline, on got and nest |
| 1.1c | a file staged and then removed without a commit | **FAIL, pre-existing** — 6 stale nodes and 12 stale edges survive. Reproduced with the pre-change code (1 stale node, the same 12 edges), so this work only widens a known hole: follow-up item 4, cleared by the next `--full` |
| 1.3 | a callback definition leaking where a real symbol is expected | **PASS** — 0 call edges resolve to a callback, 0 non-function nodes are named like one, 0 member calls reach a callback-owned symbol |

Two things 1.3 surfaced that look wrong and are not. An object-literal method
(`{ start() {}, stop() {} }`) inside a test legitimately has a callback as its owner —
and `memberOwnerSql` treats a callback owner exactly like no owner, so `x.start()`
still cannot reach it, as before. And a callback name can hold a dot, because the test
name does: `describe('lint.runChecks', …)`.

## Round 2 — 22 real TypeScript and JavaScript shapes

Every shape indexed for real and every name it produced read by hand: `.tsx`,
`test.each`, three nesting levels, two same-named tests in one file, a name past the
cap, a template literal with interpolation, `describe.skip` / `it.only`, an async
function expression, a generator, an IIFE, a callback in an object literal, one in an
array, a class static block, a decorator argument, an empty body, a member call, a
default-parameter arrow, a class field arrow, a promise chain, a returned callback, a
bare arrow parameter.

**It found a real defect.** Reading only the last part of a member expression turned
`describe.skip('my suite', …)` into `skip:my suite`, which reads as a suite named
"skip"; `it.only` became `only:` and `test.each` became `each:`. All three are everyday
test shapes. Fixed by using the whole dotted path when every part of it is a plain
name. The first fix then broke `promise.then(…).catch(…)` — both callbacks became
`callback@2` — which the same shape probe caught, so a chain whose head is not a name
keeps the method: `catch@2`, `finally@2`, `map@2`.

## Round 3 — are the answers right, on THIS repo

**3.1 — every certain row audited, which had never been done here.** `measure.mjs`
only ever checked 22 symbols on seven other repositories. The same mechanical reasons,
applied to all 4,514 certain call edges in this repo:

| | rows |
|---|---|
| target is in the calling file | 3,990 |
| the calling file imports the target file | 476 |
| no mechanical reason — read by hand | 48 |

Of those 48: **37 correct** — 34 are `out` and `warn` reached through `ctx` under the
same name (`const { out, die } = ctx`), and 3 are behind a dynamic `import()` the check
cannot see. **11 are FALSE, and marked certain.** Every one is identical before and
after this work, so all 11 are pre-existing:

| rows | the call | the graph's answer | why it is wrong |
|---|---|---|---|
| 5 | `writeConfig(dir, cfg)` in p-tasks and p-wiki tests, each importing it from its own `../lib/config.mjs` | a test-local helper in **p-shed** | the right target is `.mjs` (lang js) and the caller is `.ts`, so the language gate hides it; the only ts candidate is a foreign test helper, which then looks unique |
| 3 | `out()` in a p-observe test, where `out` is a property of a returned object | a `function out()` in a **p-tasks** test | same language gate, plus: a destructured object property is not a definition, so nothing shadows the name |
| 2 | `r()` inside `new Promise((r) => …)` — `r` is the arrow's own parameter | a `const r = …` in a **p-graph** test | a parameter is not a definition, so Pass L sees nothing to shadow with |
| 1 | `textOf(it)` where `textOf` is a parameter of `applyFilterList(items, filter, textOf)` | `function textOf` in **p-shed** | the same parameter cause, and here both files are `.mjs`, so the language gate is not involved |

So **11 of 4,514 certain rows are false on this repo (0.24%)**, from two causes that the
README does not name:

1. **A call on a local binding that is not a definition** — a parameter, or a
   destructured property. Pass L refuses a cross-file match when the calling file holds
   a *definition* of that name, but a parameter is not one, so the name still reaches a
   unique top-level function elsewhere and is called certain. The facts needed to refuse
   are already extracted (`tsVarKeys` holds every TS/JS binding with its scope span);
   they are simply not consulted by the resolver.
2. **The TypeScript/JavaScript language gate can manufacture uniqueness.** Every pass
   requires the same language on both ends. When the right target is `.mjs` and the
   caller is `.ts`, the right one is invisible — and if exactly one same-language
   candidate exists anywhere in the repo, it is taken and marked certain.

Neither is caused by this work; both are now measured. The README's "no certain row was
false" is measured on seven other repositories and **does not hold here**.

**3.2 — silent misses, the failure a code graph is bought to prevent.** 13 real symbols,
every textual call site in the repo classified:

| | |
|---|---|
| call sites in the source | 240 |
| found in the answer | 33 |
| named as a gap | 207 |
| **silent** | **0** |

Nothing is dropped without being reported. The 33/207 split is the language gate again:
most call sites of a `.mjs` function from a `.ts` test are honestly reported rather than
answered.

## Round 4 — robustness

An empty file, a whitespace-only file, a file that is one callback, a file with a syntax
error mid-way, 2,000 callbacks in one file, a 10,000-character test name, a name of only
whitespace, quotes and escapes in a name, emoji and CJK, a call with no string argument.
**No crash, no corrupt graph.** The syntax-error file still yields the definitions before
the break. 2,000 callbacks index in 762 ms for the whole eleven-file set.

**It found the second defect in this work.** The 80-character name cap cut by UTF-16 code
units, so an emoji at the cap kept half of itself — the same bug this repo already fixed
for the signature cap. Worth recording how nearly it was missed: the round's own check
read the name back **out of SQLite**, which silently substitutes a lone surrogate half,
so the check reported zero damage while the function really was producing it. The
regression test asserts on what the driver returns, not on what the database stored.

## One wart, not fixed

A callback qname can repeat across files: `beforeEach@9` is the qname of 40 different
hooks here, because 40 test files open with a module-scope `beforeEach` on line 9. 52
callback qnames are duplicated, covering 271 of 3,204 callback nodes. This is the same
property the README already documents for ordinary symbols (`write` ×28, `run` ×27), but
it removes the escape hatch that paragraph offers: for a hook, asking by qname does not
disambiguate either. The `file:line` printed beside every row is the identifier.
