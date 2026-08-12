# grep vs p-graph

August 2026. p-graph 1.3.1, plus the changes this page paid for. We already knew whether the graph's
own rows are right — `measure.mjs` has audited that for months. What nobody had measured is the
question a user actually has: **should I ask the graph, or should I just grep?**

So we ran the contest. The same structural questions, put to the same agent twice: once with nothing
but `grep` and `Read`, once with p-graph indexed and installed. **Twelve public repositories at pinned
commits, three per language**, 31 questions, 186 runs in the current set, every number re-makeable
from this repo.

The first pass said p-graph loses. Six rounds of fixes came out of it — one change did nothing, the
rest closed real gaps. The numbers below are the current ones; every fix and every outcome is written
up further down, because a page that only shows the winning attempt is not a measurement.

Two of those rounds happened only because the question set grew. Every language started on ONE
repository, then two, now three. Each time a repository was added the picture changed, and twice it
changed the sign of a headline number. A benchmark that fits one repository per language measures the
repository.

Below, **grep** means an agent with `grep` and `Read` and nothing else. **p-graph** means the same
agent with the graph built, the plugin loaded and the rule installed — it still has grep, and it uses
it.

## The answer

| What we measured | grep | p-graph | Gap | Verdict |
|---|---|---|---|---|
| **"who calls X"** — call sites found | **1401 of 1410** | 1392 of 1410 | −9 | **grep** |
| **"who calls X"** — call sites invented | 51 | **19** | −63% | **p-graph** |
| **"who calls X"** — cost per question | $0.241 | $0.239 | −1% (SE $0.018, 0.1 SE) | **noise** |
| **"who calls X"** — time per question | 44.5 s | 44.6 s | +0% (SE 3.8 s, 0.0 SE) | **noise** |
| **"who calls X"** — steps per question | 7.6 | 7.3 | −4% (SE 0.5, 0.6 SE) | **noise** |
| **"who calls X"** — tool calls | 6.6 | **6.3** | −5% | **noise** |
| **"who calls X"** — context read back | **632k** | 679k | +7% | **grep** |
| **"who calls X"** — text searches | 3.7 | **1.9** | −49% | **p-graph** |
| **"what breaks if X changes"** — cost | $0.86 | **$0.42** | −51% | **p-graph** |
| **"what breaks if X changes"** — time | 237 s | **91 s** | −62% | **p-graph** |
| **"what breaks if X changes"** — steps | 50 | **7** | −85% | **p-graph** |
| Text searches per question, every question | 4.3 | **1.9** | −56% | **p-graph** |
| Answers that admit their own limits | 8% (7/93) | **45% (42/93)** | +37 pts | **p-graph** |

**tie** means the two sides landed on the same number. **noise** means the gap is under two standard
errors, so we cannot tell it from zero.

**Two things survive at three repositories per language, and they are not the ones we expected.**
p-graph invents a third as many call sites, and it says what it might be missing in 45% of answers
against grep's 8%. Cost, time and steps are all under one standard error: on price there is no
difference. An earlier version of this page reported −21% cost at 1.8 SE and −24% steps at 2.0 SE.
Those numbers were real for the set they were measured on — 19 questions in seven repositories — and
they did not survive the set growing to 31 questions in twelve.

Recall now goes the other way by nine call sites, and it is worth saying exactly where that comes
from, because the honest answer is "run-to-run variance on one hard question". On `re2::Prog::size`
grep scored 57 of 75 in one pass and 75 of 75 in the next, and the difference was money: $0.74 and
123 s against $1.11 and 213 s. p-graph scored 74 of 75 both times. The "+22 call sites" this page used
to claim for C++ was one cheap grep run, not a property of the graph.

The invented rows still come from one question. On `Handler.ServeHTTP` in caddy grep averages 17
invented call sites per run against p-graph's 5.7: it cannot tell a call written on the `Handler`
interface from one written on a concrete middleware, and 107 lines in that repo carry a `.ServeHTTP(`
call. That one question is where all 51 of grep's invented rows and 17 of p-graph's 19 come from.

How big is "noise" here? We re-ran the untouched baseline arm on the C++ questions, changing nothing
about it, and its own cost moved 18% and its time 16% between the two passes. That is the yardstick
for every gap on this page.

## By language

Three repositories per language. Three runs each side — 186 runs.

| Language | Repos | Questions | Call sites found, grep / p-graph | Invented | Cost, grep / p-graph | Time, grep / p-graph | Cost gap |
|---|---|---:|---|---|---|---|---|
| Go | hugo, caddy, gin | 6 | 331 of 336 / **334 of 336** | 51 / **17** | $0.300 / **$0.251** | 65 s / **51 s** | **−16%** |
| Python | flask, requests, httpx | 5 | 135 of 135 / 135 of 135 | 0 / 0 | $0.184 / $0.180 | 31 s / 32 s | −2% |
| C++ | leveldb, re2, spdlog | 9 | 476 of 480 / **477 of 480** | 0 / 0 | **$0.301** / $0.327 | **52 s** / 58 s | **+9%** |
| TypeScript | nest, got, axios | 9 | **459 of 459** / 446 of 459 | **0** / 2 | $0.177 / $0.171 | **29 s** / 32 s | −3% |

Go is the only language that wins on every axis at once. C++ buys the best recall of the four and pays
9% more for it. Python is a clean tie. TypeScript loses 13 call sites, all on axios — plain JavaScript
with no type annotations, where the graph falls back to matching by name.

Every language except Python carries more than three questions, always for the same reason: the first
three were a free function or a call on a plain local, the shapes that already worked, so no fix to the
shape the language actually writes could have shown up here at all. Each extra question was written,
with its ground truth, BEFORE a line of code changed. See "Reading the value call", "The TypeScript
round" and "The Go round".

Every question, both sides. `found` and `invented` are totals over those runs; everything else is per
question. `text searches` counts Grep and grep through Bash — the graph query is not a search. The gap
column is a percentage throughout, and the last row is a share, so its gap is in percentage points.


```text
┌──────────────────────────────────────────────┬───────────────┬──────────────┬──────────────┬─────────┐
│ What we measured                             │ grep          │ p-graph      │ Gap          │ Winner  │
├──────────────────────────────────────────────┼───────────────┼──────────────┼──────────────┼─────────┤
│ "who calls X" — call sites found             │ 226 of 228    │ 226 of 228   │ +0%          │ tie     │
├──────────────────────────────────────────────┼───────────────┼──────────────┼──────────────┼─────────┤
│ "who calls X" — call sites invented          │ 51            │ 17           │ -67%         │ p-graph │
├──────────────────────────────────────────────┼───────────────┼──────────────┼──────────────┼─────────┤
│ "who calls X" — cost                         │ $0.365        │ $0.294       │ -19%         │ p-graph │
├──────────────────────────────────────────────┼───────────────┼──────────────┼──────────────┼─────────┤
│ "who calls X" — time                         │ 75 s          │ 60 s         │ -19%         │ p-graph │
├──────────────────────────────────────────────┼───────────────┼──────────────┼──────────────┼─────────┤
│ "who calls X" — tool calls                   │ 9.8           │ 8.6          │ -13%         │ p-graph │
├──────────────────────────────────────────────┼───────────────┼──────────────┼──────────────┼─────────┤
│ "who calls X" — output tokens / context read │ 11614 / 1083k │ 24314 / 879k │ +109% / -19% │ grep    │
├──────────────────────────────────────────────┼───────────────┼──────────────┼──────────────┼─────────┤
│ "who calls X" — text searches                │ 4.8           │ 2.6          │ -47%         │ p-graph │
├──────────────────────────────────────────────┼───────────────┼──────────────┼──────────────┼─────────┤
│ "what breaks if X changes" — cost            │ $0.86         │ $0.42        │ -51%         │ p-graph │
├──────────────────────────────────────────────┼───────────────┼──────────────┼──────────────┼─────────┤
│ "what breaks if X changes" — time            │ 237 s         │ 91 s         │ -62%         │ p-graph │
├──────────────────────────────────────────────┼───────────────┼──────────────┼──────────────┼─────────┤
│ "what breaks if X changes" — steps           │ 50            │ 7            │ -85%         │ p-graph │
├──────────────────────────────────────────────┼───────────────┼──────────────┼──────────────┼─────────┤
│ Answers that admit their own limits          │ 25% (3/12)    │ 42% (5/12)   │ +17 pts      │ p-graph │
└──────────────────────────────────────────────┴───────────────┴──────────────┴──────────────┴─────────┘
```

The language with the newest question and the oldest code. Three of its four questions are level or
near it — those are the package-level functions that always worked. The fourth,
`caddyhttp.Handler.ServeHTTP`, is where every number in this box comes from: it is the most expensive
question in the study on both sides, and the only one where either side invents call sites in bulk.
The output-token row is its doing too — p-graph's answers on it list far more rows, because they list
them right. See "The Go round".


```text
┌──────────────────────────────────────────────┬─────────────┬─────────────┬─────────────┬─────────┐
│ What we measured                             │ grep        │ p-graph     │ Gap         │ Winner  │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — call sites found             │ 69 of 69    │ 69 of 69    │ +0%         │ tie     │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — call sites invented          │ 0           │ 0           │ 0%          │ tie     │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — cost                         │ $0.199      │ $0.176      │ -11%        │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — time                         │ 35 s        │ 29 s        │ -16%        │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — tool calls                   │ 5.0         │ 4.0         │ -20%        │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — output tokens / context read │ 3470 / 461k │ 4811 / 383k │ +39% / -17% │ grep    │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — text searches                │ 3.9         │ 0.3         │ -91%        │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ Answers that admit their own limits          │ 33% (3/9)   │ 33% (3/9)   │ +0 pts      │ tie     │
└──────────────────────────────────────────────┴─────────────┴─────────────┴─────────────┴─────────┘
```

`RequestsCookieJar.update` is why Python comes out cheaper overall: one real call site, and `.update(`
matches a dict on every second line. grep ran **9.7 searches** on that question against p-graph's 1.0.
Both got it right. A common method name on an uncommon type is the shape a graph is for.


```text
┌──────────────────────────────────────────────┬─────────────┬─────────────┬─────────────┬─────────┐
│ What we measured                             │ grep        │ p-graph     │ Gap         │ Winner  │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — call sites found             │ 159 of 162  │ 162 of 162  │ +2%         │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — call sites invented          │ 2           │ 0           │ -100%       │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — cost                         │ $0.172      │ $0.096      │ -44%        │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — time                         │ 35 s        │ 21 s        │ -39%        │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — tool calls                   │ 4.9         │ 2.3         │ -53%        │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — output tokens / context read │ 5896 / 435k │ 2030 / 250k │ -66% / -42% │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — text searches                │ 3.1         │ 0.8         │ -74%        │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ Answers that admit their own limits          │ 0% (0/15)   │ 27% (4/15)  │ +27 pts     │ p-graph │
└──────────────────────────────────────────────┴─────────────┴─────────────┴─────────────┴─────────┘
```

It used to be **+77% cost and +117% time**. Three of its five questions are level — those are the
shapes that already worked. The two that carry the result are the ones added for that round, and one
of them carries most of it: see "Reading the value call".


```text
┌──────────────────────────────────────────────┬─────────────┬─────────────┬─────────────┬─────────┐
│ What we measured                             │ grep        │ p-graph     │ Gap         │ Winner  │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — call sites found             │ 177 of 177  │ 177 of 177  │ +0%         │ tie     │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — call sites invented          │ 0           │ 0           │ 0%          │ tie     │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — cost                         │ $0.164      │ $0.133      │ -18%        │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — time                         │ 26 s        │ 19 s        │ -25%        │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — tool calls                   │ 3.5         │ 1.7         │ -52%        │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — output tokens / context read │ 3524 / 293k │ 1789 / 196k │ -49% / -33% │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — text searches                │ 2.3         │ 0.3         │ -88%        │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ Answers that admit their own limits          │ 0% (0/15)   │ 27% (4/15)  │ +27 pts     │ p-graph │
└──────────────────────────────────────────────┴─────────────┴─────────────┴─────────────┴─────────┘
```

It used to be the only language where p-graph cost MORE than grep (+9% cost, +13% tool calls); it now
wins every row. Same two lessons as C++, in the same order: the three original questions were shapes
that already worked, and the fix that mattered was reading the type written on a class field.
`Serializer.serialize` — 20 call sites, every one of them `this.serializer.serialize(…)` — went from
"no symbol named Serializer.serialize" to a complete answer in 2 steps against grep's 5.

**C++ is the one language where p-graph finds something grep does not.** All three grep runs of
`WriteBatchInternal::Count` came back with 10 call sites of 11. The one they all missed is
`db/write_batch.cc:145`:

```cpp
void WriteBatchInternal::Append(WriteBatch* dst, const WriteBatch* src) {
  SetCount(dst, Count(dst) + Count(src));
```

The call is written `Count(...)`, unqualified, from inside the class that owns it. A search for
`WriteBatchInternal::Count` does not match it, and a search for `Count(` drowns in `SetCount`,
`GetCount` and the rest. p-graph has it by construction, because a C++ method call resolved through
its own class needs no qualifier. It got 11 of 11 in all three runs.

**C++ used to be where p-graph was most expensive** — 77% dearer and twice the time. That was not the
repo being small; it was two defects, and they are fixed. See "The four C++ fixes" below. C++ is now
11% cheaper than grep and needs no text search at all.

The three token rows are there because they explain the money and they do not line up with it.
p-graph writes 30% more text than grep and costs 1% less: at these context sizes the bill is mostly
cache reads, and those are within 1%. Writing is not what an extra step costs — re-reading everything
before it is.

**p-graph does not lose anywhere, and wins where grep cannot go.** On "who calls X" the two are level
on all three counts — same call sites found, same nothing invented, same money and time inside the
noise. On the transitive question p-graph is a third cheaper and five times fewer steps. And it says
what it does not know seven times as often.

The two search rows are the mechanism. On "who calls X" p-graph runs 0.4 text searches against grep's
2.3 — it needs fewer, but it still needs one now and then. Over every question the ratio is 3.8 to
0.4, because the transitive question alone makes grep run about twenty searches and p-graph one
`impact` call.

None of this was true two passes ago. p-graph used to run 2.0 searches on a list question on top of
the graph query, and that is where the money went.

## Question by question

Nineteen questions. Three runs each side. First number is grep, second is p-graph.

| Question | Language | Real call sites | Call sites found | Invented | Cost | Time |
|---|---|---:|---|---|---|---|
| `caddyhttp.SanitizedPathJoin` — who calls it | Go | 7 | 100% / 95% | 0 / 0 | $0.10 / $0.14 | 17 s / 14 s |
| `helpers.Exists` in hugo | Go | 11 | 100% / 100% | 0 / 0 | $0.15 / $0.13 | 29 s / 22 s |
| `bufferpool.GetBuffer` in hugo | Go | 24 | 99% / 100% | 0 / 0 | $0.14 / $0.11 | 26 s / 15 s |
| **`caddyhttp.Handler.ServeHTTP` in caddy** | Go | 34 | 99% / 99% | **17 / 5.7** | **$1.07 / $0.83** | 229 s / 185 s |
| `get_flashed_messages` in flask | Python | 6 | 100% / 100% | 0 / 0 | $0.10 / $0.11 | 14 s / 14 s |
| `RequestsCookieJar.update` | Python | 1 | 100% / 100% | 0 / 0 | $0.34 / $0.31 | 74 s / 59 s |
| `TotalFileSize` in leveldb | C++ | 8 | 100% / 100% | 0 / 0 | $0.07 / **$0.06** | 11 s / 17 s |
| `ClassSerializerInterceptor.serialize` in nest | TypeScript | 13 | 100% / 100% | 0 / 0 | $0.16 / $0.15 | 29 s / 19 s |
| **`PipesContextCreator.create` in nest** | TypeScript | 4 | 100% / 100% | 0 / 0 | **$0.26 / $0.19** | 36 s / 35 s |
| **`Serializer.serialize` in nest** | TypeScript | 20 | 100% / 100% | 0 / 0 | **$0.20 / $0.11** | **34 s / 16 s** |
| `WriteBatchInternal::Count` in leveldb | C++ | 11 | **91% / 100%** | 0 / 0 | $0.09 / $0.09 | 12 s / 16 s |
| `WriteBatchInternal::SetSequence` in leveldb | C++ | 7 | 100% / 100% | 0 / 0 | $0.07 / $0.11 | 11 s / 17 s |
| **`WriteBatch::Put` in leveldb** | C++ | 24 | 100% / 100% | **0.7 / 0** | **$0.46 / $0.07** | **103 s / 17 s** |
| `Insert` through `leveldb::Cache` | C++ | 4 | 100% / 100% | 0 / 0 | $0.18 / $0.15 | 37 s / 40 s |
| `extendArrayMetadata` in nest | TypeScript | 12 | 100% / 100% | 0 / 0 | $0.10 / $0.10 | 17 s / 12 s |
| `validateEach` in nest | TypeScript | 10 | 100% / 100% | 0 / 0 | $0.09 / $0.10 | 13 s / 14 s |
| `super_len` in requests | Python | 16 | 100% / 100% | 0 / 0 | $0.16 / $0.10 | 16 s / 14 s |
| `byteCountFlexiWriter.WriteRune` — nothing calls it | Go | 0 | — | 0 / 0 | $0.23 / $0.28 | 59 s / 61 s |
| **What breaks if `bufferpool.GetBuffer` changes** | Go | not scored | — | — | **$0.86 / $0.42** | **237 s / 91 s** |

Read the last row apart from the rest. It is the only question grep cannot answer in one step.

### The eighteen "who calls X" questions, with the noise floor

Printed by `measure-agent.mjs --score`, not worked out by hand. Eighteen, not seventeen: the trap
question — a symbol nothing calls — is a "who calls X" question too, and it is the one where an empty
answer is the right answer.

| | grep | p-graph | Difference | Noise floor |
|---|---|---|---|---|
| Call sites found | 631 of 636 | **634 of 636** | +3 | ±0.9 points |
| Call sites invented | 53 | **17** | −68% | — |
| Cost per question | $0.220 | **$0.174** | −21% | ±$0.025 on −$0.046 |
| Time per question | 42.7 s | **33.1 s** | −22% | ±5.3 s on −9.6 s |
| Steps per question | 6.7 | **5.1** | −24% | ±0.8 on −1.6 |

Cost and time point p-graph's way at 1.8 standard errors each — closer than they have ever been, and
still not proven. **Steps crosses two, at 2.0**, and it is the first row in this study to do so. All
three moved further from zero with every round that added a question of a shape the language actually
writes. None of them was moved by a fix alone.

The floor is wide because the questions are not the same size — one costs grep $1.07 and the smallest
$0.07 — so the per-question tables below carry more than this average does.

Accuracy is not a tie either way. p-graph is three call sites ahead, and it invents a third as many:
17 against 53.

### The transitive question

| | grep | p-graph |
|---|---|---|
| Cost | $0.86 | **$0.42** |
| Time | 237 s | **91 s** |
| Steps | 50 | **7** |

Half off the cost, a third of the time, and seven times fewer steps. grep has to walk the call tree by
hand, one search per level; p-graph does it in one `impact` call. Three runs each, so treat the size
with care — earlier passes put the same figure at $0.43 and $0.57 — but every pass has had it well
under grep's, and the step count is not close. It got better again in the Go round, and for a reason
worth naming: a call written on an interface used to stop the walk dead, and now it carries it.

## How the gap was closed, and the fix that did not close it

The first pass had p-graph 48% dearer and 59% slower on "who calls X". Two fixes were built. This is
what each one did.

### Fix 1 — say the answer is complete. No effect.

A complete answer used to end in silence, and "no gap banner" looks the same as "I do not know". In
12 runs the graph reported no gaps at all and the agent grepped anyway. So `callers`, `callees`,
`impact` and `context` were made to end with `✓ complete — no gaps: …`, with `complete: true` in
`--json`, and the rule was rewritten around it: this line means stop, that banner means grep.

| | Before | After |
|---|---|---|
| Runs that grepped after calling `pgraph` | 27 of 27 | 23 of 23 |
| Cost gap against grep | +$0.058 | +$0.079 |

**Nothing moved.** The change in the gap was +$0.021 with a standard error of $0.014.

### Fix 2 — print the call site. This is the one.

Reading the traces found the real cause, and it is not subtle once seen. **`pgraph callers` did not
answer the question that was asked.** It returned which *functions* call the symbol, each with the
line where that function is *declared*. The question asks where the *calls* are. Checked against the
hand-built truth on four repos:

| Symbol | Call-site lines in the old `pgraph callers` output |
|---|---|
| `caddyhttp.SanitizedPathJoin` | 0 of 7 |
| `helpers.Exists` | 0 of 11 |
| `TotalFileSize` | 0 of 8 |
| `get_flashed_messages` | 0 of 6 |

Zero of 32 — and the graph had every one of them, in `edges.file` and `edges.line`. The agent was not
double-checking out of habit. It was fetching the half of the answer that was never printed.

So the row now carries the call sites, a caller that calls twice shows both
(`fastcgi.go:310, 372`), the signature moved out to `pgraph node`, and the first line names the
symbol the query resolved to — so a bare name takes one command instead of `search` and then
`callers`.

Per question, over the eight "who calls X" questions unless the row says otherwise:

| | grep | p-graph before | p-graph after |
|---|---:|---:|---:|
| Runs that searched after asking the graph, all nine | — | 23 of 23 | **16 of 25** |
| Text searches, all nine | 5.1 | 2.0 | **0.6** |
| Tool calls | 3.7 | — | **3.8** |
| Assistant messages | 8.5 | 13.2 | **9.2** |
| Output tokens | 2,563 | 6,325 | **4,106** |
| Context read back | 348k | 586k | **378k** |
| Cache written | 30k | 46k | **46k** |
| Cost gap against grep | — | +$0.079 | **+$0.019** |
| Time gap against grep | — | +18.8 s | **−2.2 s** |

Everything moved at once, because the second query stopped happening. What is left is inside the
noise.

Note what did **not** equalise: p-graph still writes 60% more text than grep — 4,106 output tokens
against 2,563 — and still costs only 12% more. At these context sizes the bill is mostly cache reads,
and those are within 9% (378k against 348k). Writing is not what an extra step costs; re-reading
everything before it is. That is also why the failed fix could not have worked: it removed no step.

The lesson is worth more than the fix: **an answer that makes the reader run one more command is not
a cheap answer, however good its rows are.** We spent a whole pass telling the agent to trust the
tool before noticing that the tool had not answered.

What *did* move, by accident: **`/p-graph:query` went from 0 runs out of 27 to 4** — including all
three runs of the transitive question, which is exactly where the win above came from. The old rule
buried the skill under a paragraph about grepping. Rewriting that paragraph is the only change that
touched it.

The completeness line stays. It is true, it costs nothing measurable, and `impact`'s version of it
carries a claim nothing else made — that the walk refused no edge, so the answer is not a floor. But
it did not do the job it was added for, and this page is not going to pretend otherwise.

## The four C++ fixes

The per-language split found something the average had hidden: **C++ was 77% dearer and 117% slower
than grep**, on 3.5 and 6.8 standard errors — not noise, a defect. Reading the traces and the graph
found four, on two C++ repositories: leveldb (132 files) and re2 (78 files), both indexed and audited
row by row.

### What was wrong

| # | Defect | Evidence |
|---|---|---|
| 1 | `callers "Class::Method"` matched nothing — and printed **"✓ complete"** | Only the bare name and the full dotted qname worked. `WriteBatchInternal::Count`, `ns::Class::Method` and `Class.Method` all returned an empty answer that called itself complete. |
| 2 | Unqualified calls came back marked UNVERIFIED | 58% of leveldb's resolved call edges were guesses, and 49% of re2's — against 11% for Go and 5% for Python. |
| 3 | The gap report listed other languages | On re2, a C++ symbol's gap list carried Python call sites of the same name: 7 of the first 20 rows. |
| 4 | An unknown symbol claimed completeness in every language | `callers NoSuchSymbolAtAll` printed `✓ complete — no gaps`. |

Defect 1 is what the traces show costing the money. The agent asked the way C++ is written, got an
empty answer, did not believe it, and hunted:

| Question | grep, tool calls | p-graph, tool calls | What p-graph spent them on |
|---|---|---|---|
| `WriteBatchInternal::Count` | 1, 1, 1 | 5, 4, 5 | `::` → `2>&1` → `--json` → `search` → the dotted name |
| `WriteBatchInternal::SetSequence` | 1, 1, 1 | 4, 3, 1 | the same hunt |
| `TotalFileSize` | 1, 1, 1 | 6, 6, 3 | one query, then five reads of `version_set.cc` to check the guesses |

Defect 2 has one cause. C++ looks an unqualified name up in the class, then in each enclosing
namespace, then globally. p-graph recorded only the innermost reading, so `TotalFileSize(...)` written
inside `VersionSet::Finalize` was stored as `leveldb.VersionSet.TotalFileSize`, matched nothing, and
fell through to a bare-name guess. All six callers were right. All six were marked unsure.

### What was changed

1. **A query may name the tail of a qname**, with `::` read as the scope separator. Taken literally
   first — an id, a qname, a bare name — and only then as a tail, so no other language loses a query
   it already answered. Measured on leveldb: 1,488 of 1,495 `Class::Method` spellings point at exactly
   one symbol; when several fit, all of them are named instead of one being picked in silence.
2. **The name lookup walks outward**, class → enclosing namespaces → global, stopping at the first
   scope that holds the name. Reading a scope C++ really searches is knowledge, not a guess, so these
   rows are certain.
3. **The gap report keeps to the target's language.**
4. **A name no symbol carries never claims completeness** — it says `no symbol named X in the graph`.

The guard on fix 2 is the whole design. If **any** node already carries the inner qname the walk does
not happen, even when overloads make it ambiguous — because that is what C++ does, and because
without the guard `InternalKeyComparator::Compare` calling its own other overload answered with the
free `Compare`: a wrong row marked certain, and `impact` follows a certain row. Measured across both
repos, the walk lands on a name no class defines in 923 cases and on a possible inherited method in 5.

### What it bought

| | Before | After |
|---|---|---|
| leveldb, guesses as a share of resolved call edges | 58.1% | **41.7%** |
| re2, same | 49.1% | **42.0%** |
| C++ cost against grep | +77% (3.5 SE) | **−11% (0.5 SE, noise)** |
| C++ time against grep | +117% (6.8 SE) | **+17% (3.7 SE)** |
| C++ steps against grep | +156% (4.3 SE) | **−5% (1.0 SE, noise)** |
| C++ tool calls | 1.0 / 4.1 | 1.1 / **1.0** |
| C++ text searches by p-graph | 0.2 | **0.0** |
| Whole study, cost against grep | +13% | **−1%** |

The remaining +17% on time is 1.7 s a question — starting node and opening the database. It is real
and it is small.

One number went the other way, and it should. **Answers that admit their own limits fell from 7 of 9
to 2 of 9 on C++.** That was never a goal in itself; it was a proxy for honesty when the answers were
full of guesses. The answers are now certain and complete, so there is less to admit. Across the whole
study the count is now 21 of 57 against grep's 6.

## Reading the value call: the three fixes after that

The four fixes above left the biggest hole in C++ untouched, and the per-language
numbers said how big it was. A call written on a value — `x.m()`, `p->m()` — is
**40% of leveldb's call edges and 43% of re2's, and not one of leveldb's 3,681 was
certain.** C++ was the only supported language with no receiver-type table at all;
Go, Python and TypeScript have had one for months.

Two things had to be measured before anything was built, because the first ranking
of this work was wrong twice.

**The question set had none of the broken shape.** All three C++ questions were a
free function or a static method — resolved through the name, with no receiver to
type. So the fixes could not have moved the A/B by a cent, whatever they did to the
graph. Two questions were added first, with hand-built truth:

| Question | Real call sites | Why this one |
|---|---:|---|
| `WriteBatch::Put` in leveldb | 24 | Nine other classes in the repo have a `Put`, and 57 lines match `.Put(` or `->Put(`. Every call is on a value. |
| `Insert` through `leveldb::Cache` | 4 | A pure virtual. The interface method was not in the graph at all. |

Measured before the work: `callers "WriteBatch::Put"` returned **0 callers and 194
gap rows** — every `Put` call in the repo, undifferentiated. `callers "Cache::Insert"`
returned *no such symbol*.

**Two of the four planned fixes were dropped on measurement.** Marking googletest's
`ASSERT_*` macros external turned out to change no answer at all: not one of those
1,290 leveldb rows can ever appear in a listed gap banner, because no repo symbol
carries the name, so they were already counted as external. Their only cost is the
`unattributed calls` number in `status`. And indexing base classes, which the first
ranking put second on the strength of "46% of leveldb's classes have a base clause",
buys **35 call edges in leveldb and 112 in re2** — measured after the type table
landed. Class counts do not predict edge counts.

### What was built

1. **A receiver-type table for C++.** The type the source writes on a local, a
   pointer, a parameter or a class field — including the everyday layout where the
   field is in a header and the method in a `.cc` — and a call through a field of a
   typed receiver (`h->rep.Put(k)`). The written name is resolved to a class first,
   and only when exactly one class in the repo carries it; then that class's method.
   Both hops are guarded by "exactly one", so nothing here is a pick.
2. **Pure virtuals are indexed.** A `virtual m() = 0;` has no definition, so a C++
   interface method was missing from the graph entirely — `leveldb::Iterator::Valid`
   was absent while nine implementations of `Valid` were present, so a question about
   the interface answered with `SkipList::Iterator::Valid`: the wrong symbol,
   confidently. An ordinary declaration is still left out, because its definition is
   indexed already and two nodes on one qname resolve to neither.
3. **A googletest body is named after its suite and its test.** `TEST(Suite, Name)`
   reads as a function called `TEST`, and 139 leveldb definitions shared the single
   qname `leveldb.TEST_F`. Gap lines and caller rows said `leveldb.TEST_F -> Put`
   over and over with no way to tell the tests apart.

Fix 2 needed a second pass no one planned. **Every public class in leveldb is written
`class LEVELDB_EXPORT Cache { … };`**, and the macro breaks the parse: the body
becomes a statement block and an error node swallows every pure virtual after the
first — 1 of 7 in `cache.h`, 1 of 9 in `iterator.h`, 1 of 10 in `db.h`. A rule that
recovered one interface method and left its six siblings out would be worse than one
that recovered none, because a reader cannot tell which case they have. So they are
read from the source instead, the same way the class's own name already was.

### What it bought, in the graph

| | Before | After |
|---|---:|---:|
| leveldb, certain `x.m()` calls | **0** of 3,681 | **1,743** |
| re2, same | 1 of 4,009 | **1,680** |
| leveldb, certain call edges | 1,293 | **4,677** |
| leveldb, guesses | 1,796 | **228** |
| leveldb, guesses as a share of resolved | 58.1% | **4.6%** |
| re2, guesses as a share of resolved | 49.1% | **6.5%** |

For scale, that share is 4.6% on leveldb, 5.5% on requests, 6.5% on re2, 10.5% on
got, 10.6% on hugo, 10.9% on nest and 14.5% on caddy. **C++ went from the worst-resolved language in the set to
the best**, and it has stayed there: the only repo above 20% now is flask, at 42.8%,
where a Python attribute has no type written anywhere for the graph to read.

Getting there took four more fixes than the three above, and every one was found by running the A/B
and reading the call sites that were still missing — not by reading the code and guessing:

| What the source writes | What went wrong | Where |
|---|---|---|
| `ModelDB model(Opts());` | C++'s "most vexing parse" — syntactically a function declaration, so the receiver had no type | db_test.cc:2310 |
| three `class Benchmark`es, one per benchmark program | a field keyed on the class's bare name collected three different types, so the type was ambiguous | db_bench.cc:1019 |
| `shard_[Shard(hash)].Insert(…)` | a subscript receiver had no key at all | cache.cc:362 |
| `typedef SkipList<…> Table;` then `Table table_;` | the written type named no class, and leveldb also has a real `class Table` — so a class-scoped alias has to win | memtable.cc:99 |

Each was a single row in a gap banner. One row is enough: the ⚠ line sends the reader to grep, and an
answer right about 24 call sites and short by one costs exactly what having no graph costs.

The two new questions, at the graph:

| | Before | After |
|---|---|---|
| `callers "WriteBatch::Put"` | 0 callers, 194 gaps | **all 24 call sites, ✓ complete** |
| `callers "Cache::Insert"` | no such symbol | **all 4 call sites, ✓ complete** |

And in the A/B, on the question that carries the shape:

| `WriteBatch::Put`, per run | grep | p-graph |
|---|---|---|
| run 1 | $0.310 · 67 s · 11 steps | $0.109 · 12 s · 2 steps |
| run 2 | $0.326 · 80 s · 9 steps | $0.048 · 20 s · 2 steps |
| run 3 | $0.744 · 162 s · 28 steps | $0.051 · 21 s · 2 steps |

No run of one side overlaps any run of the other on any of the three columns, so this one is not the
noise floor talking. grep also invented a call site in two of its three runs; p-graph in none.

### What is still not fixed

| What | leveldb | re2 |
|---|---:|---:|
| receiver has no type written anywhere near it (a global, a chain) | 648 | 960 |
| type is known but the method is inherited, not declared | 35 | 112 |
| type is known and is not a single repo class — correctly refused | 1,360 | 1,044 |

The first row is the honest floor of this approach: reading types the source writes
cannot type a receiver the source never types. The second is what base classes would
buy, and at 35 edges it is not worth the risk — which implementation answers a
virtual call is a runtime decision, so linking `Derived.m()` to `Base::m` when
`Derived` overrides it would be a wrong row marked certain.

## The TypeScript round

TypeScript was the last language where p-graph lost. It cost **9% more** than grep and ran **13% more
tool calls**, and it was the only language on this page where a row read "grep".

The same two lessons as C++ came back in the same order.

### The question set was hiding it

Two of the three TypeScript questions were free functions — `extendArrayMetadata`, `validateEach` —
and the third was a call on a plain local. Those shapes already worked. So no fix to the shape
TypeScript actually writes could have moved the A/B, and the first thing done was to add two questions
of the broken shape, with their ground truth read by hand, BEFORE a line of code changed:

| Question | Call sites | Why it is hard | p-graph before |
|---|---:|---|---|
| `PipesContextCreator.create` | 4 | 75 nodes in the repo are named `create`, and `.create(` is written 145 times in `packages/` alone | found all 4, then printed **168** other `create` calls and told the reader to grep |
| `Serializer.serialize` | 20 | every call is `this.serializer.serialize(…)`, through a base class, an alias and an interface | **"no symbol named Serializer.serialize"** |

### What was wrong

Measured on nest (1,728 files) and sindresorhus/got, not assumed. TypeScript was the only language
where the type table held nothing but locals:

| Rows in `field_types` | hugo (Go) | flask (Py) | leveldb (C++) | nest (TS) |
|---|---:|---:|---:|---:|
| locals and parameters | 23,402 | 845 | 4,839 | 5,999 |
| class / struct field types | 3,549 | 0 | 1,272 | **0** |
| type aliases | 5 | 0 | 16 | **0** |
| interface methods, as nodes | 0 | — | — | **0**, out of 312 interfaces |

The everyday shape paid for it. `this.<field>.<method>()` is 1,019 calls in nest and not one of them
resolved, so `callers "ClassSerializerInterceptor.serialize"` found all 13 of its real call sites and
then listed 20 more that belong to a completely different `serialize` — the ⚠ banner fired, and the
agent went and grepped.

Two more holes turned up while reading the source:

- **`abstract class` is a different node type** in this grammar, and the query only matched
  `class_declaration`. `ClientProxy`, `Server` and `ContextCreator` — the base classes the whole
  framework hangs off — had **zero nodes and zero methods**.
- **No JavaScript builtin list.** Go has had `GO_BUILTINS` since the start. TypeScript had nothing, so
  `JSON.parse(…)` was answered with a repo method called `parse` (71 such guesses, and 61 for
  `assign`), and every unmatched one landed in the gap banner of whatever repo method shares the name.

### What was changed

Seven changes, each one test-first:

| # | Change | What it reads |
|---|---|---|
| 1 | `abstract class` is indexed | `abstract_class_declaration` |
| 2 | interface methods are nodes | `method_signature`, and a property whose type is a function |
| 3 | class field types | `public_field_definition` and `constructor(private readonly x: T)` |
| 4 | Pass P — a call on `this.<field>` | the field's type, through the extends chain and one alias hop |
| 5 | Pass S — a call on a class name | `NestFactory.create(app)`, plus `export const X = new T()` at the top of a module |
| 6 | JavaScript globals are external | `Object`, `JSON`, `Reflect`, `console`, `Buffer`, … |
| 7 | the gap report reads written types | a row whose receiver the source types as something else is not this target's gap |

Change 7 is the one that made the difference to the reader. The gap banner had always matched on the
bare name alone; now a row is dropped when the SOURCE says the call was made on another type. That is
not a guess about the call — it is the type on the declaration, the same fact the resolver uses.

### What it bought

In the graph, on nest:

| | before | after |
|---|---:|---:|
| certain `x.m()` calls | 2,819 | **3,750** |
| guessed `x.m()` calls | 1,327 | **930** |
| interface methods indexed | 0 | **101** |
| class field types recorded | 0 | **620** |
| gap rows on `callers "PipesContextCreator.create"` | 168 | **10** |
| `callers "Serializer.serialize"` | no such symbol | **20 of 20, ✓ complete** |
| `callers "ClassSerializerInterceptor.serialize"` | 13 of 13 + ⚠ 20 false rows | **13 of 13, ✓ complete** |

Go, Python and C++ came out byte-identical — same certain, guessed and unresolved counts on all six of
their repos.

In the A/B, TypeScript went from the only language p-graph lost to one that wins every row:

| | before | after |
|---|---|---|
| cost | $0.120 / $0.130 (**+9%**) | $0.164 / **$0.133** (−18%) |
| time | 20 s / 19 s (−1%) | 26 s / **19 s** (−25%) |
| tool calls | 1.7 / 1.9 (**+13%**) | 3.5 / **1.7** (−52%) |
| text searches | 1.1 / 0.4 | 2.3 / **0.3** |

The before column is three questions and the after is five, so the two are not the same average — the
two added questions are harder for both sides. What is comparable is the per-question rows in "By
language", and there `ClassSerializerInterceptor.serialize` alone went from $0.19 to $0.15 and from
31 s to 19 s with the grep side unchanged.

### What is still not fixed

`RecipesService.findOneById` still cannot be answered, and neither can five other `CatsService`
questions, because a TypeScript qname carries no module path: nest ships the same class name in six
sample apps, so **393 of its 9,852 qnames belong to more than one symbol** and the resolver refuses
all of them. The hint at least stopped lying — it used to print "Ask by qname to separate:
RecipesService.findOneById, RecipesService.findOneById, RecipesService.findOneById" and now names the
files instead. Fixing it properly means putting the module path into every TypeScript qname, which
changes how every symbol is spelled, in every query, for every user.

## The Go round

Go was never losing. Its cost row read **+1%**, which is a tie, and it was already winning time (−27%),
steps (−33%) and searches (−83%). The one question where grep "won" was one run at $0.279 against
$0.100 and $0.036 — the graph arm's own spread was six times the gap.

What Go had instead was a blind spot in the question set, the same one C++ and TypeScript had:

### All three questions were the shape that already worked

`SanitizedPathJoin`, `helpers.Exists`, `bufferpool.GetBuffer` — three package-level functions. **A call
through an interface, which is Go's defining idiom, was not asked about once.** And it did not work:

```
$ pgraph callers "caddyhttp.Handler.ServeHTTP"
no symbol named caddyhttp.Handler.ServeHTTP in the graph
```

| | hugo | caddy |
|---|---:|---:|
| interfaces in the graph | 328 | 66 |
| their methods, as nodes | **0** | **0** |
| call edges pointing at a repo interface | **1,241** | 91 |

Those edges were missing from every answer AND from every transitive walk: `impact` follows resolved
edges, and a call written on an interface resolved to nothing at all.

### Everything else in Go's unresolved pile is not fixable by reading types

Measured before the round, over every unresolved member call not already marked external:

| What it is | hugo | caddy | Fixable by reading the source? |
|---|---:|---:|---|
| the receiver has no type anywhere near it | 44.0% | 56.7% | no — there is nothing to read |
| the type is not a repo type (stdlib, third party) | 22.3% | 29.4% | no, and it should not be |
| typed by a call whose result cannot be read | 15.2% | 3.8% | partly, and dearly |
| a key was recorded but no type | 11.3% | 8.4% | no |
| **the type is a repo INTERFACE** | **4.5%** | **0.8%** | **yes, cheaply** |
| the method is promoted through embedding | 2.0% | 1.0% | 51 edges across both repos — dropped |
| the method exists but two packages share a name | 0.7% | 0 | only by putting the import path in every Go qname |

The last row is 188 hugo calls, and it is the same wall TypeScript hit: hugo has two directories that
both declare `package scss`, so `scss.Client.ToCSS` is two nodes on one qname and the resolver refuses
both. Fixing it changes how every symbol is spelled in every query, for every user. Not done.

### The question came first

`caddyhttp.Handler.ServeHTTP`, 34 call sites, ground truth read by hand from the receiver declarations
before a line of code changed. It is the hardest question in the study for a text search: **171 lines
in caddy carry the name and 107 of them are calls**, but only these 34 go through the `Handler`
interface. The rest are the three-argument `MiddlewareHandler.ServeHTTP`, or the standard library's own
`http.Handler`. Telling them apart means reading the receiver's declaration at all 107.

### What was changed

| # | Change | Size |
|---|---|---|
| 1 | interface methods are nodes — `(interface_type (method_spec …))` | one query line |
| 2 | a concrete implementation reports the calls that reach it through an interface | new `ℹ` line, see below |
| 3 | `nextCopy := next` takes the type of the name it was copied from | 4 more call sites found |
| 4 | the gap report drops a row whose receiver the source types as another REPO type | 3 fewer false rows |

Change 2 is the one that had to be thought about rather than just written. Indexing interface methods
answers a question that could not be asked before — and on its own it would have taken something away.
A call written on an interface used to sit unresolved in the gap report of every implementation,
warning the reader that something reaches the method which no static tool can name. Once the call
resolves to the interface, it is no longer unresolved, and that warning would simply have vanished:
`callers "Postgres.ListGroups"` would read "no callers ✓ complete" for a method that runs on every
request. So it is kept, and it now names the interface, which a text search cannot work out at all:

```
ℹ 1 call site reach this method through store.Store.ListGroups — which implementation runs is decided at run time:
    api/api.go:3  api.Serve -> ListGroups
```

Change 4 was tried in a stronger form first — drop the row whenever the written type is not the
target's — and **13 existing tests said no**. A call on a LIBRARY type is refused by the resolver and
reported, and that is a tested, published promise from two rounds earlier. The stronger form was rolled
back to "another repo type", which is provable, and the library case still reports.

### What it bought

In the graph:

| | before | after |
|---|---:|---:|
| hugo, certain `x.m()` calls | 10,376 | **10,589** |
| hugo, guessed `x.m()` calls | 1,677 | **1,543** |
| caddy, certain `x.m()` calls | 4,699 | **4,766** |
| caddy, guessed `x.m()` calls | 1,067 | **974** |
| `callers "caddyhttp.Handler.ServeHTTP"` | no such symbol | **27 of 34 sites, 14 rows still flagged** |

Python, C++ and TypeScript came out byte-identical on all six of their repos.

In the A/B:

| | before | after |
|---|---|---|
| Go cost | $0.129 / $0.130 (+1%) | $0.365 / **$0.294** (−19%) |
| Go time | 24 s / 17 s | 75 s / **60 s** |
| Go invented call sites | 0 / 0 | 51 / **17** |
| transitive question | $0.86 / $0.57 | $0.86 / **$0.42**, steps 50 / **7** |

The before and after columns are three questions against four, so they are not the same average — the
added question costs grep $1.07 and the other three cost $0.10 to $0.15. What is comparable is that the
three old questions did not move, and that the transitive question, which is the same question it
always was, went from $0.57 to $0.42 and from 10 steps to 7. Interface edges carry a walk that used to
stop dead.

### It took two measurements, and the first one lost

The first A/B after change 1 came out **worse**: $1.07 grep against **$1.68** p-graph. The graph found
23 of the 34 sites and printed 18 rows it could not place, and an ⚠ banner that long sends the agent to
grep — so it paid for the graph and for the text search. Changes 3 and 4 took the banner from 18 rows
to 14 and the found count from 23 to 27, and the re-run came in at $0.83. Same lesson as C++ and
TypeScript, for the third time: **an answer that is right and flagged incomplete costs what having no
graph costs.**

### What is still not fixed

Seven of the 34 sites, all one family: the receiver is the result of a method call. Three are written
`Routes.Compile(next).ServeHTTP(…)` with no variable at all, two are `x := Routes.Compile(next)`, one
is a field of a local (`next.next.ServeHTTP`), and one is a copy of a name that itself came from a
method call. Go already reads a function's declared result (`x := pkg.Make()`); extending that to a
METHOD callee is the next fix, and it is worth 5 of the 7.

## The third-repository round, and the five C++ fixes

Every language had been measured on one repository, then two. This round took it to three — gin for
Go, httpx for Python, spdlog for C++, axios for TypeScript — and added eight questions, half of them
chosen because a text search cannot tell the target from a namesake.

### Adding a repository changed the answer twice

| | one repo per language | two | three |
|---|---|---|---|
| C++ cost against grep | **−44%** | +17% | +9% |
| C++ call sites found | 159 / **162** of 162 | 457 / **479** of 480 | 476 / **477** of 480 |
| Study-wide cost | −21% (1.8 SE) | +1% (0.1 SE) | −1% (0.1 SE) |
| Study-wide steps | −24% (**2.0 SE**) | +4% (0.3 SE) | −4% (0.6 SE) |

The −44% and the 2.0 SE were not wrong when they were published. They were measured on five easy
questions in one small tidy repository, and they did not survive a harder set. That is the finding.

### What was wrong in C++

One question, `re2::Prog::size`, cost more than having no graph at all: $1.43 and 307 s against grep's
$0.74 and 123 s, with 35 text searches against 18. The answer itself was good — 74 of 75 call sites
against grep's 57 — but underneath it sat this:

    ⚠ 290 call sites missing from this answer:
        re2/bitstate.cc:93   re2.BitState.ShouldVisit -> size
        … and 270 more
      Confirm with a text search before treating this answer as complete.

204 of those 290 rows are `size()` on a `std::vector` or an `absl::string_view` — receivers the source
types outright. None of them could be this method. The banner sent the agent grepping and the run paid
for both strategies. Same mechanism as `caddyhttp.Handler.ServeHTTP` two rounds earlier: **what costs
money is the size of the warning, not the size of the answer.**

Four more defects turned up while measuring that one:

- **A macro before the return type renamed the method.** `SPDLOG_INLINE std::shared_ptr<logger>
  registry::get(…)` came out named `std.shared_ptr.registry.get`. 337 of spdlog's 1,323 methods were
  named after their return type, and `callers "registry.get"` answered with **zero** callers and a
  warning listing all 33. leveldb and re2 do not use the macro style, so two rounds of C++ work never
  saw it.
- **The same qname in two files refused both.** leveldb's three benchmark files each define their own
  `RandomGenerator`; the resolver saw a name that was not unique and gave up on 84 calls whose only
  possible answer was the class in the same file.
- **A short type name that two classes share refused both.** `Iterator it;` inside `namespace leveldb`
  is `leveldb::Iterator`, never the nested `leveldb::SkipList::Iterator` — C++ looks a bare name up
  from the innermost scope outwards. 382 calls sat unresolved for that alone.
- **A call through a smart pointer was read as a library call.** Only six across the three repos, but
  it has to be read anyway: without it the new library filter would delete two real call sites.

### What was changed

| Fix | Reaches |
|---|---|
| Split the ⚠ banner: a receiver the source types as a library type is counted in one line, not listed | 1,818 rows across the three repos |
| Read the owner, not the return type, when a macro precedes it | 337 methods in spdlog |
| Same qname in several files → the one in the calling file wins | 84 calls |
| A bare type name is looked up from the innermost scope outwards | 419 calls |
| A call through `shared_ptr` / `unique_ptr` goes to what it holds | 6 calls |

The library rows are **counted, never dropped**. "A call the resolver refuses is reported" is a
promise this page made two rounds ago and it still holds — nine existing tests were rewritten to say
where the row is reported rather than whether it is.

### What it bought

| C++ | before | after |
|---|---|---|
| cost against grep | +17% | **+9%** |
| time against grep | +38% | **+11%** |
| tool calls | +12% | **−11%** |
| text searches | +9% | **−41%** |
| output tokens | +52% | **−13%** |
| `Prog::size` warning | 290 rows | **27 rows** |
| certain member calls, leveldb | 47% | **59%** |
| certain member calls, spdlog | 9% | 11% |

Three of the five rows that had gone the wrong way came back. Cost and time halved. Neither crossed
zero, and `re2::Prog::size` is still the reason: it alone costs $1.46 against grep's $1.11.

### What is still not fixed

Reading every unresolved member call in the three C++ repositories, by what would reach it:

| | leveldb | re2 | spdlog |
|---|---:|---:|---:|
| receiver is provably a library type — settled, counted | 620 | 803 | 395 |
| receiver is a repo type, method name owned by several types | 358 | 48 | 13 |
| no readable declaration anywhere | 750 | 855 | 926 |

The middle row is the next piece of real work and it needs inheritance, not name matching. The bottom
row is where a text search and a graph are equally blind.

## What that means

- **For "who calls X", either tool is fine — with one exception.** Both found essentially every call
  site (631 and 634 of 636) for the same money and the same time. The exception is
  a call written without a qualifier from inside the class that owns the method: grep missed that one
  in all three runs, p-graph never did. See "By language".
- **For "what breaks if I change X", use p-graph.** A third off the cost and the time, five times
  fewer steps, and one `impact` call instead of a hand-walked call tree.
- **The reason to install it is the honesty, not the speed.** 21 answers of 57 said what they might be
  missing, against 6 of 57. That is the gap banner and the guess marking being relayed, and grep has
  no equivalent.
- **A tool that makes you run one more command is not a fast tool.** The whole 48% gap was one extra
  query, caused by `callers` answering a different question from the one it was asked.

## Where the graph still earns its place

Besides the transitive question, one more number came out clearly for the plugin. An answer is worth
more when it says what it does not know, and p-graph said so three and a half times as often:

| | Runs whose answer flags its own limits |
|---|---|
| p-graph | **21 of 57** |
| grep | 6 of 57 |

That is the gap banner and the `UNVERIFIED` marking doing their job — they are text the agent can
relay, and it does. A grep-only agent has nothing equivalent to relay.

The clearest single case is `RequestsCookieJar.update` in requests. The graph hands the agent
**11 rows: 1 certain and 10 guesses**, and only the certain one is a real call — every `.update(` in
that repo is a dict or a `CaseInsensitiveDict`. The marking held: the agent read each guess, ruled it
out, and answered with the one true call site. So the guess marking works exactly as designed. It is
also not free — that question is the most expensive of the nine on both sides, though p-graph now
comes in under grep on it: $0.31 against $0.34.

## Is the graph itself right?

Re-measured today with `measure.mjs`, on the same seven repos at the same pinned commits:

| | Rows |
|---|---:|
| Resolved call edges over the 22 test symbols | 1,620 |
| Marked certain | 1,411 |
| Marked a guess | 209 |
| Certain rows with no checkable reason to mean that symbol | **0** |

1,403 of the 1,411 certain rows have a mechanical reason; the other 8 are flask's `url_for`, read by
hand and listed by the script. That is the invariant the whole design rests on, and it holds.

Against the last published run (1,734 resolved, 1,353 certain, 381 guesses), **certain rows went up
and guesses went down**. Guesses fell by 45%. The big moves:

| Symbol | Then | Now |
|---|---|---|
| got `setHeader` | 91 rows, 89 of them guesses | **5 rows** — 86 fewer, the rest reported as gaps |
| hugo `collections.Namespace.Index` | 37 rows, all guesses | 13 rows, 2 certain |
| requests `RequestsCookieJar.set` | 38 rows, 1 certain | 22 rows, 16 certain |
| hugo `byteCountFlexiWriter.WriteRune` | 3 rows, all guesses | **0 rows** — and 0 is right |

That last one is worth naming. Nothing in hugo calls that method by name: it satisfies the
`hugio.FlexiWriter` interface and is reached through it. The old three rows were wrong, they were
marked as guesses, and they are now gone. We turned it into question 8 of the A/B for the same
reason, and neither side invented a caller.

## Will it pay off in my repo?

Two numbers decide it: how much of your repo the graph can read, and how much of what it reads it can
place.

| Repo | Source files / all tracked | Call sites | Placed on a repo symbol | Certain, of those placed |
|---|---|---:|---:|---:|
| gohugoio/hugo | 931 / 2,543 — 37% | 55,499 | 32% | **89%** |
| caddyserver/caddy | 326 / 639 — 51% | 23,642 | 32% | 86% |
| nestjs/nest | 1,728 / 2,129 — 81% | 38,315 | 24% | **89%** |
| pallets/flask | 83 / 236 — 35% | 3,905 | 32% | 57% |
| psf/requests | 37 / 130 — 28% | 2,684 | 42% | **94%** |
| sindresorhus/got | 85 / 127 — 67% | 14,329 | 13% | **90%** |
| google/leveldb | 132 / 154 — 86% | 9,241 | **53%** | **95%** |
| google/re2 | 89 / 111 — 80% | 8,273 | 46% | **94%** |

"Placed" means the call reached a symbol in your repo. The rest are standard library, third party, or
a call the graph would not link — all of them reported, never hidden. A quarter to a third is normal;
most calls in most code go somewhere else.

The column that matters is the last one. **High share certain → the answers are checkable facts. Low
share → most rows are leads you still have to read**, which is what the requests question above cost.
flask at 57% is now the warning case, and it is the last one left: a Python attribute has no type
written anywhere, so the graph guesses. leveldb used to sit at 42% here and now sits at 95% — that
row is what reading the type on a C++ declaration bought. `pgraph status` gives you the placed share
for your own repo as `unattributed calls N/M`; for the certain share, run `measure-cost.mjs` against
it.

## What it costs to keep

| Repo | Files | Full index | Database | Per 1k files | Index after one edit | One query | `git grep` |
|---|---:|---:|---:|---:|---:|---:|---:|
| hugo | 930 | 20.4 s | 27.4 MB | 29.5 MB | 1.5 s | 173 ms | 138 ms |
| caddy | 326 | 5.1 s | 11.2 MB | 34.4 MB | 0.8 s | 155 ms | 66 ms |
| nest | 1,728 | 61.3 s | 23.1 MB | 13.4 MB | 0.9 s | 196 ms | 124 ms |
| flask | 83 | 1.8 s | 2.0 MB | 23.8 MB | 0.4 s | 188 ms | 72 ms |
| requests | 37 | 0.9 s | 1.3 MB | 34.9 MB | 0.5 s | 160 ms | 51 ms |
| got | 85 | 4.0 s | 6.8 MB | 79.7 MB | 0.7 s | 174 ms | 52 ms |
| leveldb | 132 | 9.5 s | 3.3 MB | 25.3 MB | 2.0 s | 197 ms | 55 ms |

Two things to plan around. **A full index of a 1,700-file repo takes about a minute**, and a schema
bump makes every user pay it once. And **a graph query is not faster than a text search** — 155–197 ms
against 51–138 ms. The README already says a text search costs about the same on a 900-file Go repo;
measured, the graph is the slower of the two on all seven. The daily cost is small either way: one
edit reparses in under two seconds.

## What we got wrong

- **A fix that only added coverage made the answer more expensive, and we shipped nothing until the
  second measurement.** Indexing Go interface methods took `callers "caddyhttp.Handler.ServeHTTP"` from
  "no symbol named" to 23 of 34 call sites — and the A/B came out WORSE: $1.07 grep against $1.68
  p-graph. The 18 rows the graph could not place were an ⚠ banner, and a banner that long sends the
  agent to grep, so the run paid for both. Two more fixes took it to 27 sites and 14 rows and the cost
  to $0.83. Third round in a row where the deciding factor was the size of the banner, not the size of
  the answer.
- **We tried to hide rows we had promised to show, and only the tests caught it.** The gap filter was
  first written as "drop any row whose receiver the source types as something other than the target".
  That reads fine and it is wrong: a call on a LIBRARY type is refused by the resolver and REPORTED, and
  that promise was made, tested and published two rounds earlier. 13 tests failed at once. The filter
  now only rules out another REPO type, which is provable, and the library case still reports. The
  suite was the only thing standing between a quiet regression and the published page.
- **Indexing interface methods would have silently deleted a warning, and the plan did not mention it.**
  Once a call written on an interface resolves, it is no longer unresolved, so it leaves the gap report
  of every concrete implementation — and `callers "Postgres.ListGroups"` would have read "no callers ✓
  complete" for a method that runs on every request. The plan called this "one query line". It was one
  query line plus a whole new report section, and the only reason we noticed is that four existing tests
  went red for exactly that reason.
- **We sized a fix with a broken measurement and nearly dropped the one that mattered.** The plan
  said "look a field up in base classes: 1 case in nest, not worth it". The counting script read the
  `extends` clause out of the class node's stored signature, and that signature is the class's FIRST
  LINE only — nest writes `export class ClientKafka` and `extends ClientProxy<…>` on the line after.
  So almost every base class in the repo was invisible to the count. The shape it scored at 1 was in
  fact the shape that carried the whole flagship question: all 20 calls to `Serializer.serialize` go
  through a field declared on a base class. Two rounds running, a ranking has been wrong because of
  how the numbers were gathered, not because of what they said.
- **The plan's ranking and the reader's experience were not the same thing.** Every fix in the plan
  was about resolving more calls, and they did: 2,819 certain member calls became 3,750. But the ⚠
  banner on `PipesContextCreator.create` only fell from 168 rows to 50, and a banner that long sends
  the agent to grep whatever the graph resolved. What took it to 10 was a change that resolves
  nothing — teaching the gap report to drop a row whose receiver the source types as something else.
  It was not in the plan at all.
- **A test passed before the fix, for a reason that had nothing to do with the fix.** "A call on
  `JSON.parse` is not reported as a gap" was green on the old code — because the bare-name fallback
  had already claimed the call, so it was never a gap to begin with. It only became a real test after
  a second repo class was added to make the fallback refuse. This is the third round in which a test
  had to be rewritten because it was green for the wrong reason; watching it fail is not enough,
  the failure has to be the one you meant.
- **A fix we shipped broke resolution somewhere else, and only the A/B found it.** Indexing pure
  virtuals gave `leveldb.DB.Put` two nodes — the declaration in db.h and the default implementation
  in db_impl.cc — so the exact-qname pass refused both, `db_->Put(…)` stopped resolving, and the two
  calls turned up in the gap report of an unrelated symbol. The unit tests were all green: none of
  them had a pure virtual WITH a definition, which is a shape C++ allows and leveldb uses on every
  interface. Cost: one whole graph-arm pass, run against a graph that was quietly worse than the one
  before it.
- **We ranked the next round of work by the wrong numbers, twice in one list.** The plan put
  "mark the test macros external" first as cheap and visible: measured, it changes no answer at
  all, because none of those 1,290 rows can reach a listed gap banner. It put base classes second
  on the strength of "46% of leveldb's classes have a base clause": measured, they are worth 35
  call edges. Counting classes, or counting edges that were never going to be read, is not the
  same as counting what an answer would gain. Both were dropped, not built.
- **A ranked plan is not a measurement either.** The same list promised the four earlier fixes
  would show up in the A/B — and they could not have, because every C++ question in the set was a
  free function or a static method, which is the one shape that already worked. The questions had
  to be written before the code. That is now the first step of any language-specific work here.
- **A published number was labelled with the wrong sample.** The headline noise-floor table said
  "the twelve who calls X questions" and was computed over thirteen — the trap question was in the
  arithmetic and out of the title. It was found by making the script print the table instead of
  keeping it in the document: the script disagreed with the page. The count is now thirteen in both,
  and the table comes from `measure-agent.mjs --score`.
- **We averaged four languages together and called C++ a small-repo effect.** The page said p-graph
  cost more on leveldb because leveldb is small and grep is fast there. That was a story, not a
  measurement. The real cause was that a `Class::Method` query matched nothing at all — measured only
  after the per-language split forced the question. A plausible explanation is the easiest thing on
  this page to get wrong, and it is the second time it happened.
- **We published a cause before we had tested it, and it was the wrong cause.** The first version of
  this page said the extra cost was the agent double-checking out of habit, and proposed the remedy in
  the same breath. Both were guesses dressed as conclusions. The remedy changed nothing, and the real
  cause — `callers` not printing what it was asked for — was sitting in the traces the whole time.
  Reading them took twenty minutes and would have saved a whole $7 pass.
- **One run in the first pass answered a different question.** On hugo `bufferpool.GetBuffer` the
  graph side spent ten turns and finished with "Done — temp files removed." — no answer at all. It
  put that row at 67% and it stayed in the published table, because dropping a bad run for being bad
  is how a study lies. The re-run has no such failure.
- **One run short on each side.** grep listed 23 of 24 on `bufferpool.GetBuffer` — it dropped
  `bufferpool/bufpool_test.go:25`, the call inside the package's own test, written as a bare
  `GetBuffer()`. p-graph listed 6 of 7 on `SanitizedPathJoin`, dropping the test call on purpose
  ("excluding the definition and the test call") without saying which line it meant. One miss each in
  210 is not a difference.
- **Our scoring punished the better answer, and we nearly published that too.** Two p-graph runs
  reported every call site but put the test one under its own heading. The extractor was told to skip
  anything the answer "rules out", and it read a separate heading as a rejection — scoring a complete
  answer at 6 of 7. Fixed by narrowing the rule to sites the answer says are *not calls*, and
  re-extracting both sides.
- **Our first scoring pass was wrong and would have published a false result.** It read call sites out
  of the answers with a regular expression, and answers come as markdown tables — so it scored a
  perfect answer at 0%. The fix was to have a model copy the claimed sites out of the answer, and
  score that list mechanically. The first model we used for it was too small: it returned 1 site out
  of 13 for an answer whose second table names the file once as a heading. Both bugs would have made
  the plugin look worse than it is.
- **We nearly measured the wrong thing entirely.** This machine has p-graph, p-wiki and a Go LSP
  switched on for every session. Left alone, the grep side would have had all three, and the Go
  questions would have been answered by `gopls`. The runner switches them off on both
  sides. Anyone re-running this on their own machine has the same trap.

## Method

- Seven public repos, cloned fresh and pinned to the commits in `measure.mjs`. Both arms are the same
  clone, so the source is byte-identical.
- Three passes: the first measured p-graph as it shipped, the second after the completeness line, the
  third after the call sites. The grep runs are from the first pass and are reused, because nothing
  about grep changed. Every pass is kept — `runs-before.jsonl` and `runs-pass2.jsonl` in the work
  directory.
- **grep** — the repo as it comes: no `.pgraph`, no rule, no plugin. **p-graph** — the same clone,
  indexed with `index --full`, with the rule `/p-graph:init` installs written to `CLAUDE.md` and the
  plugin loaded, so both `/p-graph:query` and the CLI are there. p-graph keeps grep, and uses it.
- Same model (`sonnet`), same tools on both sides, same question text. Subagents are switched off, so
  one run cannot fan out and skew its own cost — the fault p-wiki's study had to withdraw a row for.
  So are the edit tools, though that did not fully hold: one run still wrote temp files through Bash,
  and it is the broken run named above.
- Ground truth is a hand-read list of the real call sites for each symbol, built from a text search
  and then checked one by one. An answer covers a call site if it cites that file and a line inside
  the calling function, so "the caller is `Apply` at line 77" and "the call is at line 83" both count.
- Lines that are neither a call nor a mistake count for neither side, and each one is listed in the
  runner with why: the symbol's own definition, and `getattr(cookiejar, "update")()` in requests,
  which really does reach the method at run time and which no static tool can name.
- The noise floor is the standard error of the paired per-question differences.
- Cost and time come from `claude -p --output-format json`. Tool use is counted from the session
  transcripts.

### Where the method is weak

- **Nineteen questions, three runs, one model.** Small. Three questions per language is enough to
  notice a shape and not enough to size it, and Go, C++ and TypeScript carry more only because the
  first three in each turned out to miss the shape that was broken. A stronger model would likely make
  grep better still, which moves the "who calls X" result further against p-graph, not for it.
- **One question now carries a lot of the headline.** `Handler.ServeHTTP` costs grep $1.07 and the next
  dearest costs $0.46, so the study's average cost per question rose from $0.17 to $0.22 the moment it
  was added, on both sides. Read the per-language boxes, not just the average.
- **Eighteen of the nineteen questions are one shape**: "list every call site". That is the shape
  grep is best at. The transitive question, where the graph should be strongest, is the one we could not score
  — building ground truth for a transitive answer by hand is a study of its own.
- **p-graph gets a `CLAUDE.md` that the grep side does not.** That is deliberate — it is what
  `/p-graph:init` installs, so it is part of the thing being measured — but part of the extra cost is
  that file telling the agent to double-check with grep.
- **All seven repos are open source and well known.** The model may have seen them. That helps both
  sides, and it may flatter grep more, since p-graph reads its answer off the index.
- **The global `~/.claude/CLAUDE.md` was loaded in both arms.** Identical on both sides, but it is not
  a clean room.
- **`/p-graph:query` ran 2 times in 27 this pass, 4 in the pass before, 0 in the first.** So this page
  mostly measures p-graph read as a command-line tool, not the plugin's own skill. One confound did
  partly untangle itself: in the pass before, all three transitive runs used the skill and we could
  not tell the skill from `impact`. This pass only one of the three did, and the transitive question
  still came in a third under grep — so the win is not the skill alone. p-wiki's study has the same
  hole from the other side: `/p-wiki:query` ran once in 77.
- **Extraction is a model step.** It only copies claimed sites out of an answer and never sees the
  ground truth, but it is not a parser. The cached extractions are in `extracted.json` and can be read.
- **Nothing here measures what the graph is worth to a person** reading `pgraph context` or `explore`
  instead of opening ten files.
- **Three passes of p-graph against one pass of grep, all the same day.** The grep runs were never
  repeated, because nothing about grep changed — but the two gaps that remain are small enough that
  drift in the service between the morning and the afternoon could account for them either way.

Total cost of the study: **$55.61** for 243 answer runs, plus about $23 for extraction and false
starts. The current set is 57 runs a side and costs $25.09 to remake.

## What this suggests we change

Changed already, on the strength of this page:

- **`callers` and `callees` print the call site.** The `file:line` on a row is where the call is
  written, several lines on one row when a caller calls more than once, and the signature moved to
  `pgraph node`. `--json` gains `call_sites`. This is the change that closed the gap.
- **The first line of an answer names the symbol it resolved**, and lists them all when a bare name is
  shared, so a query is one command instead of `search` and then `callers`. `--json` gains `targets`.
- **The tool states completeness.** `✓ complete` and the `complete` field. It did not cut the cost,
  and the page says so, but it is honest and `impact`'s version says something no other line said.
- **The installed rule was rewritten** twice: around what to do with each ending, and then around
  asking by bare name and not looking the call lines up again.
- **The README leads with the result.**
- **A C++ symbol can be asked for the way C++ writes it** — `Class::Method`, `ns::Class::Method` — and
  the name lookup walks outward the way C++ does. See "The four C++ fixes".
- **A gap report keeps to the target's language, and an unknown symbol never claims completeness.**
- **The noise floor is printed by the script**, so no number on this page exists only in the document.

What the numbers point at next, in order:

1. **Build the C++ receiver-type table.** The biggest hole left in any language: 40% of leveldb's call
   edges are written on a value and none of them is certain, while about 70% of them carry a type the
   source states outright. Go, Python and TypeScript already have this machinery.
2. **Find out whether the transitive win is `impact` or `/p-graph:query`.** They are tangled: the
   winning runs used both. Re-run that question with the skill forced on and forced off. It decides
   what to tell users to type.
3. **Give the transitive question a correctness score.** It is now the plugin's strongest claim and it
   has no accuracy number at all. That needs a way to build ground truth for a transitive answer
   without a week of reading.
4. **Re-run the grep side in full.** Only the C++ third of it has been re-run. Nothing about the
   baseline changed, so there was no reason to — but its own cost moved 18% between two passes of the
   same three questions, which is the size of every gap left on this page.
5. **Add a second repo per language.** Every conclusion here rests on one or two repositories per
   language, and the C++ defects only surfaced because a second C++ repo was indexed to check them.
6. **Try the call-site fix on `impact` and `trace`.** `impact` still prints where each affected
   function is declared. Whether that costs anything is unmeasured; `callers` says it might.

## Run it again

```bash
node plugins/p-graph/scripts/measure.mjs        # is the graph itself right
node plugins/p-graph/scripts/measure-cost.mjs   # what it costs to keep, and repo fit
node plugins/p-graph/scripts/measure-agent.mjs --phase base
node plugins/p-graph/scripts/measure-agent.mjs --phase graph
node plugins/p-graph/scripts/measure-agent.mjs --score
```

`measure-agent.mjs` spends real money — about $25 for a full pass. It appends to `runs.jsonl` and
never repeats a run, so it can be stopped and restarted. To re-run part of it, delete those rows from
`runs.jsonl` and pass `--only <question-id>,<question-id>`.

`--score` prints, in order: every question; the noise-floor table this page publishes; tools and
tokens per question; and one boxed scoreboard per language. Every table on this page comes from that
output.
