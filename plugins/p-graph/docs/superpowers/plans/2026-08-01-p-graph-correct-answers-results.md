# Results: measuring p-graph's correct-answers work

This is Task 9 of the [correct-answers plan](./2026-08-01-p-graph-correct-answers.md).
Tasks 1 to 8 changed the code. This document reports what changed, measured on real
repositories, with real commands and real output. Nothing here is estimated.

Measured on 2026-08-04, at commit `fbc2637` of `feature/p-graph-trustworthy-answers`.
The test suite is green: **237 tests in 52 files**.

## How the numbers were taken

Seven projects were cloned with `git clone --depth 1`, outside this repo, and deleted
afterwards. Five are the plan's corpora; `got` and `requests` were added because two of the
plan's target queries live in them.

| Corpus | Language | Commit |
|---|---|---|
| gohugoio/hugo | Go | `70db201ed4f76d0b80c568ffa6b1d35071aabd22` |
| nestjs/nest | TypeScript | `20ad6fd000dc6cc797788b4f333871f77b46a43f` |
| pallets/flask | Python | `6a2f545bfd8ed31e19066a299296917e034aca58` |
| caddyserver/caddy | Go | `e096ca9503188f057c69a049f709fdade6077631` |
| google/leveldb | C++ | `7ee830d02b623e8ffe0b95d59a74db1e58da04c5` |
| sindresorhus/got | TypeScript | `e3924aa1e53a6ca3eb93a43618ce532442a89b40` |
| psf/requests | Python | `414f0513c33883adf6f2b46901d4f0b38a455851` |

**Every "before" number in this document was measured, not copied.** The code as it stood
before Task 1 (`9f7c36d`) was checked out as a git worktree and used to index the very same
clones. So each before/after pair compares two versions of the tool on identical source, on
one machine, minutes apart. Where a number from the plan's own brief differs from the
measured before number, both are shown and the difference is explained.

## 1. The five corpora

`node pgraph.mjs index --full`, then `status` and a direct read of the database.

| Corpus | Files | Nodes | Call edges | Resolved | Unattributed | Index | DB |
|---|---|---|---|---|---|---|---|
| hugo | 930 | 9,905 → **9,923** | 55,499 | 16,288 → **16,913** | 39,211 → **38,586** | 27.4 s → **19.1 s** | 67.2 → **25.0 MB** |
| nest | 1,728 | 5,797 → **5,804** | 38,315 | 9,633 → **7,470** | 28,682 → **30,845** | 47.6 s → **47.7 s** | 14.4 → **14.5 MB** |
| flask | 83 | 1,619 | 3,905 | 1,513 → **1,395** | 2,392 → **2,510** | 1.1 s → **1.6 s** | 1.8 → **1.8 MB** |
| caddy | 326 | 3,581 | 23,642 | 7,332 → **7,675** | 16,310 → **15,967** | 13.4 s → **4.9 s** | 100.8 → **10.5 MB** |
| leveldb | 132 | 1,548 → **2,092** | 8,368 → **9,241** | 3,131 → **3,089** | 5,237 → **6,152** | 5.9 s → **8.5 s** | 2.5 → **3.3 MB** |

The plan's brief lists slightly different before numbers, taken from older clones:
hugo 928 files / 9,882 nodes / 55,402 call edges / 16,232 resolved / 24.9 s / 70.4 MB;
nest 1,727 / 5,775 / 38,153 / 9,592 / 45.0 s / 15.0 MB;
flask 83 / 1,619 / 3,905 / 1,513 / 1.2 s / 1.8 MB;
caddy 326 / 3,553 / 23,510 / 7,320 / 12.2 s / 105.6 MB;
leveldb 132 / 1,548 / 8,368 / 3,131 / 5.1 s / 2.6 MB.
The shapes match within a few files and a few dozen edges, so the corpora are the same size
as the ones the original evaluation used.

Read this table with three things in mind.

**The database shrank a lot on the two Go repos.** caddy went from 100.8 MB to 10.5 MB and
hugo from 67.2 MB to 25.0 MB. Cause: the stored `signature` is now capped at 300
characters. The longest one before was **157,787** characters on caddy and **113,564** on
hugo — whole minified source lines, kept in the graph for no benefit. Both are now 300.

**leveldb grew because C++ finally works.** Nodes went from 1,548 to 2,092 and call edges
from 8,368 to 9,241, because out-of-class definitions are now indexed. C++ method nodes
went from 558 to 1,198, and the ones with a proper `<namespace>.<Class>.<Method>` name from
42 to 1,189. `leveldb.DBImpl.Get` did not exist as a symbol before; it does now
(`db/db_impl.cc:1121`).

**Resolved edges went down on nest, got, flask and requests, and that is the point.** nest
lost 2,163 resolved edges, got 1,310, flask 118, requests 100. The call-edge totals are
unchanged, so nothing was dropped from the graph — those calls are now reported as gaps
instead of being linked to a symbol the tool could not justify. Section 6 shows how much of
what it stopped resolving was false: on the 22 hand-checked symbols, **the before code had
1,188 false resolved edges and the after code has 165**.

On hugo and caddy resolved edges went **up** (16,288 → 16,913 and 7,332 → 7,675), because
Task 4 types Go parameters and variables, so calls that used to be unresolvable now have a
real answer. On hugo, 5,278 resolved edges now come through a typed local or parameter and
747 through a typed struct field; on caddy, 3,779 and 188.

Two more repo-wide facts:

- A Go method on a generic type keeps its receiver. hugo has 4,162 Go methods.
  **195 of them had no receiver in their name before; 0 do now.** That is exactly the count
  the plan predicted.
- hugo's three `cpp` nodes disappeared (3 → 0). They were `typedef struct json_object_t
  JSON_Object;` forward declarations in a vendored C header. A forward declaration is not a
  definition, so losing them is right, not a regression.

## 2. Certain rows and guessed rows

A resolved edge is now marked. `guess = 0` means the graph knew the receiver's type, or the
call was written with a qualifier it could check. `guess = 1` means it only matched a bare
method name that happened to be unique in the repo.

| Corpus | Resolved | Certain | Guess | Guess share |
|---|---|---|---|---|
| hugo | 16,913 | 11,793 | 5,120 | 30% |
| nest | 7,470 | 4,941 | 2,529 | 34% |
| flask | 1,395 | 601 | 794 | 57% |
| caddy | 7,675 | 6,030 | 1,645 | 21% |
| leveldb | 3,089 | 1,293 | 1,796 | 58% |
| got | 1,814 | 1,213 | 601 | 33% |
| requests | 1,100 | 887 | 213 | 19% |

By language, for the five plan corpora:

```
Go    (hugo)    15,713 resolved,  4,660 guess      Go    (caddy)  7,167 resolved, 1,470 guess
JS    (hugo)     1,200 resolved,    460 guess      JS    (caddy)    508 resolved,   175 guess
TS    (nest)     7,461 resolved,  2,529 guess
Py    (flask)    1,395 resolved,    794 guess
C++   (leveldb)  3,089 resolved,  1,796 guess
```

Go and Python-with-module-calls have the lowest guess share, because those are the two
places where the resolver can check something. C++ and flask have the highest, because
nothing types a C++ receiver and flask's own code calls a lot of dict and framework methods
whose names collide with its own.

The split matters because of one measured result in section 6: **of 1,352 certain rows in
the grep-agreement set, 0 are false. All 165 false rows in that set are marked as guesses.**

## 3. The queries that were wrong

`gopls` reference counts are the ground truth for the hugo rows, as the plan specifies.

| Symbol | gopls | Before | After: certain | After: guess | Of the after rows, real |
|---|---|---|---|---|---|
| `goldmark.idFactory.Put` | 0 | 12 rows, no warning | **0** | **1** | 0 of 1 |
| `collections.Namespace.Index` | 3 | 32 rows | **0** | **26** | 1 of 26 |
| `highlight.byteCountFlexiWriter.WriteRune` | 1 | 7 rows | **0** | **2** | 0 of 2 |
| `bufferpool.GetBuffer` | 24 | 20 rows / 24 sites | **20** | **0** | 20 of 20 |

Row by row, with the source read.

**`goldmark.idFactory.Put`: 12 wrong rows became 1, and it is labelled.** The 12 before were
all `sync.Pool.Put` on a package-level pool (`bufferPool.Put(buf)`, `timerPool.Put(t)` and
nine more). All 11 named pools are now in the count line
("11 same-name call sites in files that do not import the target's package"). The one
remaining row is `attributes.go:133`, `pc.IDs().Put(id.([]byte))`. That is a call on a
function's return value, through goldmark's `parser.IDs` interface. hugo's `idFactory` does
satisfy that interface, so the row is not absurd — but `gopls` counts 0 direct references,
so it is a false direct caller. It is printed under `UNVERIFIED`, never as the answer.

**`collections.Namespace.Index`: 32 rows became 26, and this one is still bad.** A text
search finds 92 `.Index(` sites in hugo. Exactly two of them call the queried method:
`tpl/collections/index_test.go:68` and `:81`, both `ns.Index(...)` on a `*Namespace`. So the
answer prints **1 real row and 25 false ones** — the false ones are all
`reflect.Value.Index`. Cause: `lv := reflect.ValueOf(l)` types a local from a **function
return value**, which Task 4 does not read (it reads `var`, parameters, composite literals
and `new(T)`). Every one of the 26 rows is marked `UNVERIFIED`, and the answer has no
certain rows at all, so nothing here is presented as fact. But the row count is still far
from 3. See section 7, item 1.
`gopls`'s third reference is `tpl/collections/init.go:90`, `ns.AddMethodMapping(ctx.Index, ...)`
— a method value, not a call. p-graph tracks calls, so it cannot report that one.

**`highlight.byteCountFlexiWriter.WriteRune`: 7 rows became 2, both false, and the one real
site is flagged.** The two rows are `buf.WriteRune('-')` in `autoid.go` and `b.WriteRune(r)`
in `tpl/template.go`, where `buf` and `b` both come from `bp.GetBuffer()` — a
`*bytes.Buffer` from the standard library, again a function return value. The real site,
`highlight.go:359` (`w.delegate.WriteRune(r)`, an interface-typed field), is named in the
gap banner. Interface dispatch is out of scope for this plan, so a gap is the correct
answer there.

**`bufferpool.GetBuffer`: unchanged and fully correct.** 20 caller rows covering all 24 real
call sites, every row certain, no banner. A text search finds exactly 24 call sites and the
graph resolved all 24.

### got and flask

| Symbol | Repo | Before: resolved / false | After: resolved / false | After: rows printed |
|---|---|---|---|---|
| `end` | got | 825 / 824 | **1 / 0** | 0 certain, 1 guess |
| `exec` | got | 92 / 82 | **0 / 0** | 0 rows, 92 gap rows |
| `setHeader` | got | 91 / 89 | **91 / 89** | 1 certain, 9 guess |
| `get` | requests | 175 / 91 | **84 / 0** | 69 certain rows |
| `RequestsCookieJar.set` | requests | 38 / 22 | **38 / 22** | 1 certain, 27 guess |
| `RequestsCookieJar.update` | requests | 16 / 15 | **16 / 15** | 0 certain, 14 guess |
| `get` | flask | — | **0 / 0** | 0 rows, 382 gap rows |

**`end` is the headline fix.** A ten-line arrow function named `end`, declared inside one
method body, used to answer all 825 `.end()` calls in got. It now answers exactly one — the
plain `end();` on the line below it, which is the only real call. The other 824 are named in
the gap banner. Before: 824 false rows. After: 0.

**`exec` went to zero false and zero true.** All 92 resolved edges before pointed at one node
(`exec` at `test/helpers/with-server.ts:148`, the `withSocketServer` macro's method). Only
the 10 `withSocketServer.exec(...)` calls really target it; the 76 `withServer.exec(...)`
calls target `generateHook.exec` and the 2 `withHttpsServer().exec(...)` calls target
`generateHttpsHook.exec`, so those 78 were pointing at the wrong symbol, plus 4 hits that
are JavaScript's `RegExp.prototype.exec`. That is the plan's "82 false", reproduced
exactly. Now nothing resolves and all 88 real sites are in the gap list. Honest, and 10 true
rows poorer.

**`setHeader` did not improve.** 89 of 91 resolved edges are still false, all
`response.setHeader(...)` on Node's `ServerResponse` in got's tests. The target is a real
class method with a real owner, so Task 6's rule allows the link, and TypeScript has no
equivalent of Task 4's Go type recording. What did change: the 2 real sites
(`this.setHeader(...)` inside the constructor) are the **only certain rows**, and all 89
false ones sit under `UNVERIFIED`.

**`get` in requests is now exact.** 175 resolved edges became 84, and all 84 are the real
`requests.get(...)` call sites. Checked against a text search line by line: 85 grep hits, 84
resolved, 1 unmatched — and that one is `>>> r = requests.get(...)` inside the module
docstring. The plan's brief says "84 real of 175"; the after answer is 84 of 84, zero false.
The cost: 46 other real `get` sites (`session.get(...)`, `jar.get(...)`,
`requests.codes.get(...)`) moved from resolved rows into the gap list.

**The two cookie-jar symbols did not improve in count.** `RequestsCookieJar.set` still has 22
false edges (20 `threading.Event.set()` calls and 2 uses of Python's builtin `set()`) and 16
real ones. `RequestsCookieJar.update` still has 15 false and 1 real. Same cause as
`setHeader`: a real method with a real owner, called on untyped Python values. The marking
is the whole gain — `set` prints 1 certain row (the real `self.set(...)`) and 27 under
`UNVERIFIED`; `update` prints 0 certain rows and 14 under `UNVERIFIED`.

**flask's `get` prints nothing and says so.** 0 resolved rows, 382 gap rows. Before this plan
flask's `Scaffold.get` and friends collected `.get()` calls from dicts across the repo.

## 4. Precision, checked by hand, twice

Both samples are uniform random draws with a seeded PRNG, so they are reproducible.

### Sample A: 25 resolved Go edges on hugo, drawn uniformly

**25 of 25 correct — 100%.** Split by confidence: 17 certain rows, 17 correct; 8 guessed
rows, 8 correct. Each row was checked by opening `file:line`, reading the call, and finding
the receiver's real type (including, where needed, grepping for every implementer of the
method to prove there is only one).

The eight guessed rows were all right for the same reason: five are
`b.AssertFileContent(...)`-style calls where `b := hugolib.Test(t, files)` returns the one
type in hugo with those methods, one is inside a `switch img := src.(type)` branch, one is a
promoted method through two levels of embedding, and one goes through an interface whose
only implementer in the repo is the recorded target. The resolver did not verify any of
those types; the names simply happen to be unique. That is what `UNVERIFIED` is for.

The previous plan's equivalent sample was 19 of 20 correct, with the one wrong row being a
`sync.Pool.Put` on a package-level variable — exactly the class Task 4 removed.

### Sample B: 15 edges from the class an earlier evaluation found 47% wrong

The class: a **guessed** Go edge whose calling file neither belongs to the target's package
nor imports it. On hugo that class now holds **369 edges of 15,713 resolved Go edges
(2.3%)**.

**12 of 15 correct, 3 wrong — 20% wrong, down from 47%.**

The three wrong ones share one shape the plan does not cover: **a struct field that holds a
function**.

| # | Call site | Recorded target | Why it is wrong |
|---|---|---|---|
| 9 | `hugolib/page__meta.go:963` — `s.conf.C.CreateTitle(m.term)` | `allconfig.ConfigLanguage.CreateTitle` | `ConfigCompiled.CreateTitle` is a **field** of type `func(string) string`, not a method. The recorded method's own body is `return c.config.C.CreateTitle(s)` — a different symbol. |
| 12 | `parser/pageparser/item_test.go:203` — `tt.call(tt.item, tt.source)` | `template.call` | `call` is a table-test struct field holding a func. The recorded target is an unrelated free function in hugo's vendored text/template. |
| 13 | `resources/images/text.go:94` — `face.Metrics().Ascent.Ceil()` | `math.Namespace.Ceil` | `Ascent` is `fixed.Int26_6` from `golang.org/x/image`. A third-party method, linked to hugo's own template helper. |

A stricter reading of the 12 correct ones: six reach their target directly, and six reach it
through an interface that has exactly one implementer in the repo (`loggers.Logger` →
`logAdapter`, `config.AllProvider` → `ConfigLanguage`). `gopls` would count those six
references against the interface method rather than the concrete one. For a "who calls this"
question, naming the only implementation is the useful answer, so they are counted correct
here — but the distinction is worth knowing.

**Why both samples were required.** The uniform sample shows 0% wrong. The targeted sample
shows 20% wrong. A uniform draw over 15,713 edges would need about 130 rows to expect even
three from a class holding 2.3% of them. Reporting only the uniform number would hide the
remaining defect completely.

## 5. The two regressions are gone

CLI to CLI, same clones, the pre-plan CLI run against its own index of the same checkout.

| Command | Before | After | Change |
|---|---|---|---|
| hugo `impact bufferpool.GetBuffer` | 11,052 ms | **399 / 408 / 363 ms** (3 runs) | 28× faster |
| hugo `impact goldmark.idFactory.Put` | 24,082 ms | **187 ms** | 129× faster |
| caddy `impact caddy.Context.App` | 1,302 ms | **196 ms** | 6.6× faster |
| caddy `impact caddy.ParseDuration` | 880 ms | **190 ms** | 4.6× faster |
| caddy `impact caddyhttp.Server.ServeHTTP` | 202 ms | **177 ms** | unchanged, already fast |

The plan's brief cites 15,555 ms on hugo and 2,373 ms on caddy. On this machine the same
hugo query measures 11,052 ms before, and the worst hugo case found measures 24,082 ms
before. The brief does not record which caddy symbol produced 2,373 ms, so three were timed
and the worst before/after pair is reported. Every hugo and caddy `impact` measured is now
under 400 ms.

The store call underneath, timed directly, is where the cost was:

```
before  gapsAround('bufferpool.GetBuffer')    3,927 rows in 13,783 ms
after   gapsAround('bufferpool.GetBuffer')    3,803 rows in    189 ms
before  gapsAround('goldmark.idFactory.Put')  4,634 rows in 26,185 ms
after   gapsAround('goldmark.idFactory.Put')     11 rows in     22 ms
```

`goldmark.idFactory.Put` shows the second effect too. Its impact set was **723 symbols —
7.3% of hugo — seeded entirely by 12 false leaf edges.** It is now **0**, with one honest
line:

```
$ node pgraph.mjs impact goldmark.idFactory.Put
(no impact)
1 guessed edge (receiver type unknown) near this target was not followed, so a real impact through one may be missing.
  11 same-name call sites in files that do not import the target's package — likely unrelated, not listed.
  Confirm with a text search before treating this answer as complete.
```

`--json` reports the same as a number: `{"impact": [], "skipped_guesses": 1, "gaps": [...11 rows]}`.

### Asking by bare name no longer loses the gap report

```
$ node pgraph.mjs callers createNestApplication --json
callers: certain 0 guess 6   gaps 184   {"no-caller/reachable=1": 184}

$ node pgraph.mjs callers TestingModule.createNestApplication --json
callers: certain 0 guess 6   gaps 184   {"no-caller/reachable=1": 184}
```

Before this plan: 184 gap rows by qname, **0** by bare name. The two answers now agree
exactly — same 6 caller rows, same 184 gap rows, and the printed text is identical. One
change worth naming: the 6 caller rows are now marked `UNVERIFIED`, because
`module.createNestApplication()` is a call on a variable whose type comes from a chained
function call, which TypeScript resolution cannot check. All 190 of those edges are in fact
correct (section 6), so the marking is cautious rather than wrong.

## 6. Grep agreement — the acceptance test

**22 symbols** were measured: 9 Go (hugo, caddy), 6 TypeScript (got, nest), 5 Python
(requests, flask) and 2 C++ (leveldb).

Method: scan every source file for a textual call of the symbol's bare name; drop the
symbol's own declaration lines; group the hits by the receiver expression written in the
source, because the receiver is what decides the real target; then read the source for each
distinct receiver and decide whether that hit is a real call site of the queried symbol.
Each real call site is then classified:

- **found** — a resolved row in the answer;
- **flagged** — named in the `⚠ N call sites missing from this answer` list;
- **counted** — folded into one of the two count lines;
- **silent** — nowhere in the answer.

And each resolved edge is judged real or false against the receiver's actual type. The full
per-symbol table, with every silent hit and its source line, is in the working report.

### Real call sites: what the answer does with each

| | Count | Share |
|---|---|---|
| Real call sites found by text search | **1,724** | 100% |
| found — a resolved row | 1,569 | 91.0% |
| flagged — named in the gap list | 153 | 8.9% |
| counted — folded into a count line | 0 | 0% |
| **silent — nowhere** | **2** | **0.12%** |

### Resolved rows: how many are false

| | Resolved edges | False | False rate |
|---|---|---|---|
| Before this plan (same clones) | 2,767 | 1,188 | **42.9%** |
| After this plan | 1,734 | 165 | **9.5%** |
| After — certain rows only | 1,352 | **0** | **0.0%** |
| After — guessed rows only | 382 | 165 | 43.2% |

**Every false row in the whole set is marked as a guess.** Not one certain row is wrong.
That is the plan's central claim, and it holds across all four languages and all 22 symbols.

The earlier evaluation reported **0 silent of 2,438** and **32.5% of resolved sites false**.
Both of those numbers came from a different symbol set, so they are not line-for-line
comparable with the 42.9% measured here on the same clones with the same method. The
direction is what matters, and it is large: the false rate fell by a factor of 4.5 overall,
and to zero on the rows the tool presents as facts.

### The silent misses — read this carefully

2 real call sites of 1,724 are silent, both in nest:
`integration/hello-world/e2e/fastify-multiple.spec.ts:23` and `:25`.

**This is not a rise caused by this plan.** Checked directly against the pre-plan index of
the same clone:

```
before  edges recorded in fastify-multiple.spec.ts: 0
after   edges recorded in fastify-multiple.spec.ts: 0
before  nest files with no nodes and no edges: 102 of 1,728
after   nest files with no nodes and no edges: 102 of 1,728
```

The file produced nothing before and produces nothing now. It is one of 102 nest files in
that state, and `index` names it in its own "zero nodes (393)" list, so the tool does not
hide it. The cause is the plan's own stated exclusion: nest writes its tests inside
`describe`/`it` callbacks, and a function body passed as a call argument is not treated as a
definition. The earlier evaluation's 0 silent came from a symbol set and text scan that did
not reach these two lines — this run found them because the scan was widened to match a call
written with a generic type argument (`module.createNestApplication<NestFastifyApplication>(...)`).
So: **a newly detected pre-existing gap, not a new regression.**

Nothing the plan stopped resolving went silent. Every one of the 153 flagged sites — 88 got
`exec` calls, 46 requests `get` calls, 17 leveldb `DBImpl::Get` calls, 1 hugo `WriteRune`
call, 1 flask `current_app.url_for` call — is named in the gap report.

Two more results from the same sweep:

- `leveldb.DBImpl.Get` was **unanswerable** before: the symbol did not exist, so `callers`
  exited with "symbol not found". Now the symbol exists and all 17 real call sites are
  flagged. Still 0 resolved rows, but silence became a report.
- The scan classified 39 hits as silent in total. Every one except those two is a
  declaration, a comment, a docstring, a doctest line or a string literal — not a call site,
  so it never entered the 1,724. All 39 are listed with their source lines in the working
  report, so none has to be taken on trust.

## 7. What is still not fixed

Nine items, all measured, so none is mistaken for a new problem.

1. **`collections.Namespace.Index` still prints 26 caller rows where `gopls` says 3, and 25
   are false.** Cause: a local typed from a **function return value** (`lv := reflect.ValueOf(l)`).
   Task 4 reads `var` declarations, parameters, composite literals and `new(T)`; it does not
   follow a function's return type. All 26 rows are marked `UNVERIFIED` and there are no
   certain rows, so nothing is presented as fact — but the count is still wrong by 25.
2. **A struct field that holds a function is matched as if it were a method.** Three of the
   15 rows in the hard-class sample fail this way (`ConfigCompiled.CreateTitle`,
   a table-test `call` field, and a third-party `Ceil`). The graph records fields' types but
   does not know that a `func`-typed field is not a method, so the bare-name fallback still
   claims a same-named method.
3. **TypeScript, JavaScript, Python and C++ receivers are still untyped.** Task 4's type
   recording is Go only. Every remaining false row in section 6 comes from this: got
   `setHeader` (89 false, unchanged), `RequestsCookieJar.set` (22 false, unchanged),
   `RequestsCookieJar.update` (15 false, unchanged). Task 6's owner rule fixed the case where
   the target had **no** owner (`end`: 824 false → 0). It cannot help when the target is a
   real method of a real class and the receiver is simply unknown.
4. **Interface dispatch is still out of scope, as planned.** `highlight.byteCountFlexiWriter.WriteRune`
   keeps 2 false rows and its one real site stays a gap. `goldmark.idFactory.Put` keeps 1
   false row, `pc.IDs().Put(...)`, which is an interface call the graph cannot follow.
5. **The plan traded away some true rows.** got `exec` lost 10 correct rows, requests `get`
   lost 46, and nest lost 2,163 resolved edges overall. None went silent — all are in the gap
   report — but a user who wants those rows now has to read the banner instead of the answer.
6. **Two real call sites in nest are silent, and 102 of nest's 1,728 files still produce no
   nodes and no edges.** Pre-existing and confirmed unchanged by this plan (section 6). It is
   the `describe`/`it` callback-body exclusion the plan states up front.
7. **The guess share is high where it can least be checked.** leveldb 58% of resolved edges
   are guesses, flask 57%. The rows are marked, which is honest, but "more than half the
   answer is unverified" is a weak answer, and the mark carries no strength — a guess backed
   by a repo-unique name reads the same as a guess on a name shared with the standard library.
8. **`callers leveldb.DBImpl.Get` returns no rows at all.** All 17 real call sites are only
   flagged. C++ has no receiver typing, and `db_->Get(...)` goes through a `DB*` pointer, so
   nothing links.
9. **`TotalArea` could not be re-measured.** The plan cites `callers TotalArea` on leveldb as
   printing nothing at all. No symbol or text named `TotalArea` exists in the current leveldb
   checkout (the nearest is `TotalFileSize`), so that specific query was not re-run.
   `TotalFileSize` was measured instead: 8 real call sites, 8 found, 0 false.

## 8. The smaller Task 8 fixes, confirmed

| Fix | Check | Result |
|---|---|---|
| Signature capped | longest stored `signature` | caddy 157,787 → **300**; hugo 113,564 → **300** |
| Database size | `.pgraph` on disk | caddy 100.8 → **10.5 MB**; hugo 67.2 → **25.0 MB** |
| Drift counts only files the index reads | append a line to hugo's `README.md`, run `status` | **`drift 0`** |
| No git stderr leak | `index`, `status`, `callers` in a non-git folder | no `fatal: not a git repository` line anywhere; one clean staleness banner |
| Read-only `.pgraph` directory answers | deny write with `icacls`, run `callers` | answer printed, `exit=0`, one banner, no double `pgraph: p-graph:` prefix |

## Summary

| Measure | Before | After |
|---|---|---|
| False resolved rows, 22 hand-checked symbols | 1,188 of 2,767 (42.9%) | **165 of 1,734 (9.5%)** |
| False rows among rows shown as certain | not distinguished | **0 of 1,352 (0.0%)** |
| Real call sites nowhere in the answer | 0 reported earlier | **2 of 1,724 (0.12%), both pre-existing** |
| Uniform 25-edge Go sample | 19 of 20 correct (previous plan) | **25 of 25 correct** |
| Hard-class 15-edge sample | 47% wrong | **20% wrong** |
| hugo `impact` worst case | 24,082 ms | **187 ms** |
| caddy `impact` worst case | 1,302 ms | **196 ms** |
| `impact goldmark.idFactory.Put` | 723 symbols, all false | **0 symbols, 1 guess refused** |
| nest bare name vs qname gap rows | 0 vs 184 | **184 vs 184** |
| Go methods missing their receiver (hugo) | 195 of 4,162 | **0 of 4,162** |
| C++ method symbols (leveldb) | 558 | **1,198** |
| Longest stored signature (caddy) | 157,787 chars | **300 chars** |
| Database size (caddy) | 100.8 MB | **10.5 MB** |
