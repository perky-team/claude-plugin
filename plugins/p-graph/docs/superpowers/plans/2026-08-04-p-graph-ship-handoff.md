# p-graph: ship the trustworthy-answers branch

**Read this first, then do the four steps. Do not start a new review cycle.**

Branch: `feature/p-graph-trustworthy-answers`, HEAD `ab0c8f1`.
Suite: `npx vitest run plugins/p-graph` — **248 tests, all green**. Working tree clean.

## What already happened

Two plans landed on this branch, 47 commits, +9,989 lines. Both are in this folder with their measured results:

| File | What it is |
|---|---|
| `2026-07-31-p-graph-trustworthy-answers.md` + `-results.md` | Plan 1: stop the graph hiding what it could not resolve |
| `2026-08-01-p-graph-correct-answers.md` + `-results.md` | Plan 2: make the answers right, by giving the resolver the receiver's type |

A running log of every task, every review finding and every deferred item is at
`.superpowers/sdd/progress.md`. It is git-ignored scratch, so it exists on this machine only. **Read it before touching anything** — it records why several decisions look the way they do. `git clean -fdx` destroys it; recover from `git log` if that happens.

Measured on real repositories (gohugoio/hugo, nestjs/nest, pallets/flask, caddyserver/caddy, google/leveldb, sindresorhus/got, psf/requests), with `gopls` as ground truth where it applies:

| | Before | Now |
|---|---|---|
| False rows among resolved | 42.9% | 9.5% |
| False rows among **certain** | — | **0 of 1,352** |
| Silent misses | the original complaint | 2 of 1,724, both pre-existing |
| `impact` on hugo | 15,555 ms | 399 ms |
| caddy database | 105.6 MB | 10.5 MB |

## Why this handoff exists

The work converged; the review loop did not. Each round kept finding narrower defects, and the last two Criticals it found are already fixed (`1c1ac74`, `ab0c8f1`). Meanwhile `plugin.json` is still `0.7.1`, so the marketplace serves users the old code and **none of this reaches anyone**.

So: four bounded steps, then ship. Everything else goes to the follow-up list at the bottom.

---

## Step 1 — Two guards can be deleted with the suite still green

Both were found by the final whole-branch review, which ran each mutation and reported **all tests passing**. Nothing added since covers them. These two guards carry the branch's headline claim, so a deletable guard is a fragile claim.

**1a.** `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs`, the `MIN(e.guess)` in the `callers`/`callees` query. Its rule, documented just below it: a caller that is certain by **any** path must not be buried under the `UNVERIFIED` heading. Change `MIN` to `MAX` and the suite still passes — under `MAX`, every caller reached by both a certain and a guessed edge silently moves under `UNVERIFIED`.

Write a test with one target reached by a certain edge and a guessed edge from the same caller, plus a second caller reached only by a guess. Assert the first is certain and appears once, the second is a guess.

**1b.** `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs`, Pass F's `count(DISTINCT ft.type) … = 1`. Change `= 1` to `>= 1` and the suite still passes.

While you are there: `plugins/p-graph/tools/__tests__/receiver-types.test.ts`, the test named `refuses a variable that is assigned two different types`, is vacuous. Its fixture declares **two** variables (`var x *A`, `y := &B{}`), each with one type, and its assertions say both calls **resolve** — the opposite of the name. A sibling test at the top of the same file already proves what it actually checks. Rewrite it so the fixture really assigns two types to one variable and the guard is exercised.

**Verify by mutation, not by the RED log.** Make each change, run the suite, watch the new test fail, revert, confirm green.

## Step 2 — `--stale-ok` after the schema bump returns a confident empty answer

`SCHEMA_VERSION` went 4 → 7, and `openStore` drops the graph tables the moment any command opens an older database. On the opt-out paths `ensureFresh` then returns before rebuilding, so:

```
$ pgraph callers main.clamp --stale-ok --json
{"callers":[],"gaps":[]}
```

Byte-indistinguishable from a real zero-caller answer. `skills/query/SKILL.md` tells Claude to consume `--json`, where a banner on stderr is invisible. `PGRAPH_AUTOREFRESH=0` is a plausible CI setting, and the schema bump puts **every** existing user through this state once.

The banner text in `plugins/p-graph/tools/lib/freshness.mjs` is also wrong for it — the graph was not "built by an older version", it was erased seconds ago.

Make an empty answer caused by an erased graph distinguishable in **both** text and JSON. Do not silently rebuild when the user asked not to. Neither call site is tested today: replacing the banner constant with junk leaves the suite green.

## Step 3 — Bump and release

Per `.claude/CLAUDE.md`'s release procedure. Only `p-graph` changed on this branch.

- `plugins/p-graph/.claude-plugin/plugin.json`: **`0.7.1` → `1.0.0`**
- Monorepo tag: **`v6.0.0`** (last tag `v5.30.0`)

Major, for three reasons a user has to adapt to:

1. **The `--json` contract broke.** `callers --json` used to emit a bare array; it now emits `{callers: […], gaps: […]}`. Same for `callees`, `impact`, `trace`, `context`. Any script doing `jq '.[0].qname'` breaks.
2. **The text output changed** — a new `UNVERIFIED:` block, a gap banner, a skipped-guesses line, and an `unattributed calls N/M` field on `status`.
3. **`SCHEMA_VERSION` 4 → 7 forces one full reindex for every existing user**, and the first command they run erases the old graph.

Then, and only with an explicit go from the user: `git tag v6.0.0`, `git push`, `git push --tags`.

## Step 4 — Record what is left

Write the follow-up list below into a new plan file, or hand it to the user. Do not implement any of it here.

---

## The stop rule

**After step 2, no new review round.** Verify by running the suite and the two mutations above yourself. If step 2 uncovers something new, **write it in the follow-up list and do not fix it.**

The reason is on the record: the last review round cost about half an hour of agent time and found one command missing a marker plus a Go pattern that appears in none of hugo, caddy or prometheus. Both are fixed. The remaining known items cannot make the graph answer a normal query wrongly — they make it answer emptily or loudly in two specific setups.

---

## Follow-up, not for this session

Ordered by how much wrongness each one still causes.

1. **A receiver typed from a function's return value** (`x := reflect.ValueOf(...)`, `buf := bp.GetBuffer()`) has no recorded type, so it resolves by unique bare name — a guess. This is the largest remaining source of wrong rows: `collections.Namespace.Index` prints 26 rows where `gopls` says 3, and all 25 false ones are this shape. Reading a repo function's declared return type would close most of it.
2. **A type table for TypeScript and Python.** A real method with a real owner, called on an untyped value, still resolves wrongly — got's `setHeader` 89 false rows, `RequestsCookieJar.set` 22, `.update` 15. An owner rule cannot help; only a type can.
3. **A C++ type table.** C++ is usable for calls written `Class::method(...)` — 11 of 11 correct on a real leveldb symbol — but a member call on a value is about 40% of C++ calls and still cannot resolve.
4. **Interface dispatch.** No `implements` edges. A call through an interface with one implementation resolves to it as a guess; with two or more it becomes a gap. The honest answer is "these N types could receive this call".
5. **The read-only fallback does not survive a pre-schema-6 database.** `callers`, `callees`, `impact` and `context` exit 3 with `no such column: e.dst_bare`, because the gap-report statements name columns the old schema lacks — in the one situation the fallback exists for, a filesystem that can never be migrated. `search`, `node`, `files`, `explore` and `status` still work. Make those four degrade instead.
6. **`impactSkippedGuesses` counts edges `impact` would never have followed** — it omits the `src_id IS NOT NULL` that `impact` requires, so a guessed module-scope call is reported both as a skipped guess and as a `no-caller` gap.
7. **A missing argument prints a SQLite error.** `callers`, `callees`, `impact`, `context`, `node` and `trace` print `pgraph: Provided value cannot be bound to SQLite parameter 1.` and exit 3. `search` has the right check; copy it.
8. **TypeScript call-argument function bodies are not definitions.** `describe`/`it` callbacks, so 394 of nest's 1,727 files produce no symbols and a majority of resolved edges there have no source symbol. They surface as `outside any indexed symbol`, but they have no caller.
9. **Two repo packages sharing a base name** collapse into one qname space, so a call can resolve to the wrong package's symbol.
10. **`gitChangedFiles` cannot see a file created and deleted without a commit**, so a stale row survives until the next `--full`.
11. **The row-level evidence for "0 of 1,352 certain rows false" is git-ignored.** It lives in `.superpowers/sdd/task-9-report.md`. It is the branch's strongest claim and nobody can audit it from the repo — move that table next to the results document.
12. Smaller, all recorded in `.superpowers/sdd/progress.md`: an assertion in `alias-resolution.test.ts` that no longer distinguishes the two variable-key shapes; duplicated test coverage across four pairs of files; 126 duplicate `leveldb` namespace nodes; a macro-broken C++ class body that can make a class look like a caller of its own method; Python extraction 1.6× slower than before, entirely from the new local-variable captures.

## Known cost of what shipped, so it is not rediscovered as a bug

- A word past the 300-character signature cap is no longer findable with `search`. Searching by name or qname is unaffected. The cap took caddy's database from 105.6 MB to 10.5 MB.
- A C++ pure virtual declared in a header with no in-repo definition is not in the graph. Indexing declarations was tried and measured: it cost 620 resolved edges and made `store.node` a coin flip between a definition and an edgeless declaration.
- Some real edges are refused on purpose where the receiver's type is known to live outside the repo. Every one of them appears in the gap report; none went silent.
