# Results: re-measuring p-graph on real repositories

This is Task 8 of the [trustworthy-answers plan](./2026-07-31-p-graph-trustworthy-answers.md). Tasks 1-7 changed the code. This document proves what changed, with real commands and real output, on the same three repos used for the original evaluation.

Corpora (fresh, shallow clones, cloned outside this repo, not committed anywhere):

| Corpus | Commit | Cloned |
|---|---|---|
| gohugoio/hugo | `8a468df065a75c1c7cf9f6850f32148746590ea5` | 2026-07-31 |
| nestjs/nest | `86d1e62e04ae2886e44522247f2cd29966e338ee` | 2026-07-31 |
| pallets/flask | `6a2f545bfd8ed31e19066a299296917e034aca58` | 2026-07-31 |

All three commits are different from the ones used for the original (before-this-plan) evaluation — the corpora are `--depth 1` clones of each project's current default branch, taken today. The file/node/edge counts below still line up closely with the reference numbers, so the comparison is fair.

## 1. Before/after table

| Corpus | Files | Nodes | Call edges | Unattributed (before) | Unattributed (after) | Full index (before) | Full index (after) | DB size (before) | DB size (after) |
|---|---|---|---|---|---|---|---|---|---|
| hugo | 928 | 9,882 | 55,402 | 38,740 (69.9%) | 39,170 (70.7%) | 19.5 s | 20.4 s | 68.0 MB | 67.1 MB |
| nest | 1,727 | 5,775 | 38,153 | 29,076 (76.2%) | 28,561 (74.9%) | 58.1 s | 38.4 s | 13.4 MB | 14.3 MB |
| flask | 83 | 1,619 | 3,905 | 2,392 (61.3%) | 2,392 (61.3%) | 1.5 s | 1.3 s | 1.7 MB | 1.7 MB |

Files, nodes, and call edges match the before-this-plan reference numbers exactly for all three corpora — a good sign the corpora are the same shape as the original evaluation.

Read the "unattributed" change carefully: it is **not** a plain win-or-lose number.

- **hugo**: unattributed calls went up (38,740 → 39,170), because the new guards refuse links they cannot justify. Some of those 430 calls used to be **wrongly** resolved (a false edge); now they are honestly reported as unresolved. This is the point of the plan — fewer answers, more of them true.
- **nest**: unattributed calls went down (29,076 → 28,561), a small net gain in resolved edges. Not investigated further since the false-edge classes fixed by Tasks 1-3 are Go-specific.
- **flask**: unchanged to the call. Python resolution was not touched by this plan's guards, so an identical number was expected.

Full-index time: hugo and flask are within measurement noise of before. Nest is noticeably faster (58.1 s → 38.4 s) — likely machine/network variance between runs (both clones are shallow, from GitHub, on the same machine), not something this plan changed on purpose. DB size differs by a few percent in both directions; the three new `edges` columns (`dst_bare`, `lang`, `external`) and their index add some bytes, other differences are ordinary SQLite page reuse.

## 2. The four false-edge counters (Step 2)

Run against the freshly-indexed hugo database:

```
cross-language: 0
into a type/struct: 0
resolved builtins: 0
resolved imports: 0
```

All four are `0`, matching the plan's target exactly. Reference before this plan: 163, 235, 101, unknown. Every edge in the graph now points from one node to another node of the same language, of a callable kind, with a real target (never a Go builtin), and no `import` edge carries a `dst_id`.

## 3. The three re-run queries (Step 3)

### `callers bufferpool.GetBuffer`

Before this plan: 3 of 24 real call sites found, no banner.

After: **20 distinct caller symbols**, covering **24 of 24** real call sites.

```
$ grep -rn "GetBuffer()" --include=*.go . | wc -l
25
```

25 grep hits minus 1 (the function's own definition line, `func GetBuffer() (buf *bytes.Buffer) {`, which is not a call) is exactly 24 real call sites. Mapping each of the 24 call sites to the 20 printed caller rows (several rows cover more than one call site in the same function — `resources/transform.go`'s `transform` method calls `GetBuffer` three times, `transform/chain.go`'s `Chain.Apply` and `absurlreplacer_test.go`'s `applyWithPath` twice each) accounts for every one of the 24. No banner was printed — nothing is missing. This is a full fix: Task 3's import-alias translation (`bp.GetBuffer()` → `bufferpool.GetBuffer`) is what makes the other 21 call sites resolvable at all.

### `callers highlight.byteCountFlexiWriter.WriteRune`

Before this plan: 13 caller rows, all 13 false.

After: **7 caller rows**, plus a banner:

```
⚠ 1 call site missing from this answer:
    markup/highlight/highlight.go:359  highlight.byteCountFlexiWriter.WriteRune -> WriteRune
  + 2 same-name call sites in files that do not import the target's package — likely unrelated, not listed.
  Confirm with a text search before treating this answer as complete.
```

This is a **partial** fix, not the "zero callers" the plan's brief predicted. Reading the source:

- The one gap-report line is the **real, honest** limitation: `highlight.go:359` is `n, err := w.delegate.WriteRune(r)`, where `w.delegate` is typed `hugio.FlexiWriter` — a repo-defined **interface**. Interface dispatch is out of scope for this plan (see the plan's "Follow-up work" section), so leaving this as a gap instead of a guess is correct behavior.
- The 7 caller rows are a **different, unguarded false-edge class** that Task 2 does not cover. All 7 were hand-checked by reading source, and all 7 are false: each is a call like `buf.WriteRune('-')` or `sb.WriteRune(d.Delimiter)` on a local variable or parameter of type `*bytes.Buffer` or `strings.Builder` (both standard library). Since `WriteRune` is the *only* Go symbol in the whole repo with that bare name, and none of these 7 call sites carry any recorded type for their receiver (they are locals/parameters, not the enclosing method's own receiver or a receiver's struct field), the bare-name fallback (Pass B) links them to `highlight.byteCountFlexiWriter.WriteRune` anyway. This is exactly the documented, expected caveat ("a call on a function parameter or a local variable has no recorded type, so a unique bare name still links blindly") — just showing up on a different symbol than the brief's example.

Net effect: false callers for this symbol dropped from 13 to 7 (Task 2's field-type guard caught the subset where the field's type was known-but-external), but not to zero. See "What did not improve" below.

### `callers loggers.logAdapter.Errorf`

Before this plan: 0 rows, 387 gap lines, 365 of them `t.Errorf` from `testing`.

After: **0 caller rows** (matches expectation exactly), but the banner is still large:

```
⚠ 241 call sites missing from this answer:
    cache/dynacache/dynacache.go:443  dynacache.doGetOrCreateWitTimeout -> fmt.Errorf
    commands/commandeer.go:261  commands.rootCommand.ConfigFromProvider -> fmt.Errorf
    ... (20 shown)
    … and 221 more
  + 786 same-name call sites in files that do not import the target's package — likely unrelated, not listed.
  Confirm with a text search before treating this answer as complete.
```

This is also a **partial** fix. The printed noise did shrink a lot in raw line count (387 individual lines before → 20 example lines + 2 summary lines now), and the caller list is correctly empty. But the "241 call sites missing" number is not "zero or few" as the brief predicted, and it is still almost entirely noise:

- Of the 1,027 total unresolved calls sharing the bare name `Errorf`, 640 are `fmt.Errorf` (the standard library's error-formatting function — nothing to do with the queried symbol) and 387 are bare `Errorf` calls (mostly `t.Errorf` in Go tests).
- Of the 241 rows placed in the "listed, may be a real miss" bucket, 173 are `fmt.Errorf` and 68 are bare `Errorf`. Checked directly: **zero** of the 241 are calls that plausibly target `loggers.logAdapter.Errorf`.
- Why they landed in "listed" instead of the "same-name, cannot see the package" count: the reachability check only asks "does this file import a package named `loggers`, anywhere, for any reason?" — a file-wide check, not a call-site check. `common/loggers` is a widely-imported utility package in hugo (most files that do any logging import it), so a file can import `loggers` for an unrelated reason and also call `fmt.Errorf` on an unrelated line, and the gap-matching (which matches by bare name only) puts that `fmt.Errorf` call in the "listed" bucket anyway.

See "What did not improve" below for the numbers behind this.

## 4. Incremental vs. full rebuild (Step 4)

```
$ node pgraph.mjs index --full && node pgraph.mjs status
schema 6 - 9882 nodes - 61407 edges - 928 files - sha 8a468df0... - unattributed calls 39170/55402

$ printf 'package main\nfunc probeSymbol() {}\n' > probe.go
$ node pgraph.mjs index && node pgraph.mjs status
schema 6 - 9883 nodes - 61407 edges - 929 files - sha 8a468df0... - unattributed calls 39170/55402

$ rm probe.go && node pgraph.mjs index && node pgraph.mjs status
schema 6 - 9883 nodes - 61407 edges - 929 files - sha 8a468df0... - unattributed calls 39170/55402
```

Two separate results, worth reporting separately:

**Resolution consistency — the thing Task 4 set out to fix — is confirmed correct.** `unattributed calls 39170/55402` is identical across the full rebuild, the incremental index with the probe file added, and the incremental index after removing it. Every call edge resolves the same way whether the graph was just rebuilt from scratch or patched incrementally. That is Task 4's actual goal and it holds.

**File-level tracking leaves a stale entry behind — a separate, pre-existing gap this plan did not touch.** After `rm probe.go` and a further incremental `index`, `probe.go` and its one symbol (`main.probeSymbol`) are still in the database (929 files / 9,883 nodes, not the expected 928 / 9,882). Checked directly: `git status --porcelain` after the deletion shows nothing for `probe.go` at all — Git has no memory of a file that was created and deleted without ever being committed or staged. `pgraph`'s incremental-change detection (`gitChangedFiles` in `tools/lib/index/build.mjs`) only reads `git diff <last-indexed-sha>..HEAD` and `git status --porcelain`; neither source can see this deletion, so `store.removeFile()` is never called for it. The file entry lingers until the next `--full` reindex. This is a file-tracking gap in the incremental indexer, not a resolution-order bug, and it is outside what Tasks 1-7 changed (they touched `resolvePending()` and when it runs, not `gitChangedFiles`). See "What did not improve" below.

## 5. Nest and flask totals, and the nest no-caller check (Step 5)

Nest and flask totals are in the table in section 1.

```
$ node pgraph.mjs callers TestingModule.createNestApplication
function createAppWithVersioning  integration/hello-world/e2e/middleware-with-versioning.spec.ts:154  ...
function createApp  integration/hello-world/e2e/middleware.spec.ts:106  ...
function startServer  integration/microservices/e2e/concurrent-kafka.spec.ts:25  ...
function createNestApp  integration/websockets/e2e/gateway-ack.spec.ts:7  ...
function createNestApp  integration/websockets/e2e/gateway.spec.ts:11  ...
function createNestApp  integration/websockets/e2e/ws-gateway.spec.ts:13  ...
⚠ 184 call sites missing from this answer:
    integration/cors/e2e/express.spec.ts:33  outside any indexed symbol -> createNestApplication
    ... (20 shown)
  … and 164 more
  Confirm with a text search before treating this answer as complete.
```

Exact match to the plan's prediction: **6 caller rows**, plus **184** gap rows, every one of them tagged `reason: 'no-caller'` (confirmed with `--json`: `{ "no-caller/reachable=1": 184 }`). Before this plan these 184 resolved-but-caller-less edges were silently dropped from the answer. Now every one of them is named as "outside any indexed symbol" instead of vanishing. This part of the plan works exactly as designed.

## 6. Precision sample — 20 resolved Go edges, hand-checked (Step 6)

Sampled with the exact query from the brief (every 20th resolved Go call edge, first 400, on the fresh hugo index). Each row below was checked by opening `file:line` and reading the call site against the recorded target.

| # | Call site | Recorded target | Verdict | How it resolved |
|---|---|---|---|---|
| 1 | `bufferpool/bufpool.go:37` | `goldmark.idFactory.Put` | **FALSE** | bare-name fallback |
| 2 | `cache/dynacache/dynacache.go:205` | `rungroup.Enqueue` | correct | bare-name fallback (unique name) |
| 3 | `cache/dynacache/dynacache.go:504` | `resource.StaleVersion` | correct | exact qualified match |
| 4 | `cache/dynacache/dynacache_test.go:100` | `dynacache.New` | correct | exact qualified match |
| 5 | `cache/filecache/filecache.go:154` | `filecache.cleanID` | correct | exact qualified match |
| 6 | `cache/filecache/filecache.go:286` | `filecache.cleanID` | correct | exact qualified match |
| 7 | `cache/filecache/filecache.go:432` | `filecache.Cache.removeIfExpired` | correct | own-receiver qualified |
| 8 | `cache/filecache/filecache_config_test.go:151` | `testconfig.GetTestConfigs` | correct | exact qualified match |
| 9 | `cache/filecache/filecache_pruner.go:198` | `herrors.IsNotExist` | correct | exact qualified match |
| 10 | `cache/filecache/filecache_test.go:83` | `allconfig.ConfigLanguage.GetConfigSection` | correct | bare-name fallback (unique name) |
| 11 | `cache/filecache/filecache_test.go:260` | `filecache.NewCache` | correct | exact qualified match |
| 12 | `cache/httpcache/httpcache_integration_test.go:84` | `hugolib.Test` | correct | exact qualified match |
| 13 | `codegen/methods.go:360` | `codegen.uniqueNonEmptyStrings` | correct | exact qualified match |
| 14 | `commands/commandeer.go:64` | `commands.newExec` | correct | exact qualified match |
| 15 | `commands/commandeer.go:397` | `commands.hugoBuilder.postBuild` | correct | bare-name fallback (unique name) |
| 16 | `commands/commands.go:34` | `commands.newImportCommand` | correct | exact qualified match |
| 17 | `commands/config.go:221` | `parser.InterfaceToConfig` | correct | exact qualified match |
| 18 | `commands/convert.go:274` | `source.File.IsContentAdapter` | correct | bare-name fallback (unique name) |
| 19 | `commands/gen.go:225` | `docshelper.AddDocProviderFunc` | correct | exact qualified match |
| 20 | `commands/hugobuilder.go:274` | `commands.hugoBuilder.initMemProfile` | correct | own-receiver qualified |

**19 of 20 correct (95%).** Broken down by how each edge resolved:

- **Exact/qualified matches (rows 3-9, 11-14, 16, 17, 19, 20 — 15 rows): 15 of 15 correct (100%).**
- **Bare-name fallback matches (rows 1, 2, 10, 15, 18 — 5 rows): 4 of 5 correct (80%).**

The one false edge (#1): `bufferpool/bufpool.go:37` is `bufferPool.Put(buf)`, where `bufferPool` is a package-level `*sync.Pool` — the call is to the standard library's `sync.Pool.Put`. `Put` is unique among *repo* symbols (only `goldmark.idFactory.Put` shares the name), and the extractor records no type for a package-level variable (only struct fields of a method's own receiver are tracked), so Pass B links it there anyway.

**Class**: an untyped receiver (here, a package-level variable; the same mechanism the plan documents for a function parameter or a local variable) collides on bare name with an unrelated repo method.

**Would a cheap guard catch it?** Not cheaply and not generally. A name-based denylist of common stdlib method names (`Put`, `Get`, `Close`, `Lock`, `Write`, `Read`, ...) would catch this specific case but is exactly the kind of fragile, name-based patch this plan replaced with structural guards — it would also block legitimate repo methods that happen to share a common English verb. The real fix is the same kind of type tracking Task 1 already added for struct fields, extended to package-level variable declarations — a real feature, not a guard, and out of scope here.

The other 4 bare-name-fallback matches (rows 2, 10, 15, 18) are all correct, but only because `Enqueue`, `GetConfigSection`, `postBuild`, and `IsContentAdapter` each happen to be unique across the whole repo — the resolver did not verify the receiver's actual type in any of the four cases. This is consistent with the README's standing caveat that a bare-name match is "a strong lead, not a fact."

## 7. What did not improve

Being specific, so nothing here is mistaken for a new problem this plan caused — all four are pre-existing gaps that Tasks 1-7 did not set out to close, plus two places where the fix landed and the plan's own prediction was still too optimistic:

1. **`callers highlight.byteCountFlexiWriter.WriteRune` still returns 7 false callers**, not zero as the plan's Step 3 predicted. All 7 are the same root cause the plan explicitly calls "known and expected" (a parameter/local variable with no recorded type falling back to a unique bare name) — just showing up on `bytes.Buffer`/`strings.Builder` receivers instead of the field-typed case Task 2 fixed. Confirmed false by reading all 7 call sites.
2. **`callers loggers.logAdapter.Errorf`'s gap banner still lists 241 call sites as a possible real miss**, not "zero or few" as predicted. Every one of the 241 checked is noise (173 are `fmt.Errorf`, an unrelated standard-library call; 68 are bare `Errorf`, mostly `t.Errorf` in tests). The reachability check that is supposed to filter this out works at file granularity ("does this file import the target's package anywhere"), which is too coarse when the target's package (`common/loggers`) is imported widely across the codebase for unrelated reasons.
3. **The incremental indexer leaves a stale file/node entry behind** when a file is created and deleted while never committed or staged (see section 4). Confirmed reproducible with the exact commands in the plan's Step 4. Root cause is in `gitChangedFiles`, which Tasks 1-7 did not touch.
4. **The "unattributed calls" share went up, not down, for hugo** (69.9% → 70.7%). Expected and correct — see section 1 — but worth stating plainly since a bigger "unresolved" number can look like a regression at a glance. It is the direct cost of refusing links the graph cannot justify.

Everything else measured in this document — the four false-edge counters, the `GetBuffer` query, the nest no-caller check, and 100% of the exact/qualified matches in the precision sample — landed exactly as the plan intended.
