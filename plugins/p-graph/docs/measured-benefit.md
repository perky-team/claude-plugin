# grep vs p-graph

August 2026. Updated 14 August 2026: one truth list in this study was short by 17 call sites, and
fixing it **reversed the accuracy claim this page led with**. A third arm — a language server — was
also added. Both are in "The answer" below; the round-by-round sections further down are the record of
what earlier passes reported, and two paragraphs in them now carry a withdrawal note.

Updated 28 August 2026: `callers` on a Go interface method now also reports the calls that run
through an implementation of it, and the p-graph arm was re-measured in full — 156 runs, zero
errors — to check it. This **reversed the language-server conclusion**: "for Go, reach for the
language server first" no longer holds. See "The third arm: a language server" and "Why Go moved"
below; grep and the language server were not re-run, and none of their numbers moved.

p-graph 1.4.0 plus the Python round below, which is not released yet. We already knew whether the graph's
own rows are right — `measure.mjs` has audited that for months. What nobody had measured is the
question a user actually has: **should I ask the graph, or should I just grep?**

So we ran the contest. The same structural questions, put to the same agent twice: once with nothing
but `grep` and `Read`, once with p-graph indexed and installed. **Twelve public repositories at pinned
commits, three per language**, 42 questions, 252 runs in the current set, every number re-makeable
from this repo.

The first pass said p-graph loses. Seven rounds of fixes came out of it — one change did nothing, the
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

Fourteen repositories, 52 questions, 36 of them "who calls X" and 16 that follow the calls.

| What we measured | grep | p-graph | Gap | Verdict |
|---|---|---|---|---|
| **"who calls X"** — call sites found | **1674 of 1683** | 1650 of 1683 | −24 | **grep** |
| **"who calls X"** — call sites invented | **0** | 14 | +14 | **grep** |
| **"who calls X"** — cost per question | $0.216 | $0.199 | −8% (SE $0.026, 0.6 SE) | **noise** |
| **"who calls X"** — time per question | 39.8 s | 32.2 s | −19% (SE 3.9 s, **2.0 SE**) | **p-graph** |
| **"who calls X"** — steps per question | 6.8 | **5.7** | −16% (SE 0.4, **2.7 SE**) | **p-graph** |
| **"who calls X"** — tool calls | 6.6 | **5.3** | −20% | **p-graph** |
| **"who calls X"** — context read back | 614k | **587k** | −4% | **p-graph** |
| **"who calls X"** — text searches | 3.7 | **0.9** | −76% | **p-graph** |
| **follow the calls** — call sites found | 180 of 216 | **187 of 216** | +7 | **p-graph** |
| **follow the calls** — call sites invented | 32 | **1** | −97% | **p-graph** |
| **follow the calls** — steps per question | 9.4 | **7.6** | −19% | **p-graph** |
| **follow the calls, big repos** — cost | $0.453 | **$0.273** | −40% | **p-graph** |
| **follow the calls, big repos** — time | 103 s | **53 s** | −48% | **p-graph** |
| **follow the calls, small repos** — cost | **$0.190** | $0.232 | +22% | **grep** |
| Answers that admit their own limits | 3% (4/156) | **45% (70/156)** | +42 pts | **p-graph** |

**tie** means the two sides landed on the same number. **noise** means the gap is under two standard
errors, so we cannot tell it from zero.

**The two question shapes now give opposite answers, and that is the finding.**

On **"who calls X"** — list every call site — grep is still the more accurate of the two, but only
just. It finds 24 more call sites of 1,683 and it invents nothing at all, where p-graph invents 14.
That gap used to be 72 sites; most of it closed on 28 August when `callers` on a Go interface method
started reporting the calls that reach it through an implementation — see "Why Go moved" below. What
p-graph buys on this shape is not correctness: it is 16% fewer steps, a quarter of the text searches,
and an answer that says what it might be missing 45% of the time against grep's 3%.

On **following the calls** — "what breaks if I change X", "how does X reach Y" — p-graph wins the
accuracy row outright: 187 of 216 against 180, and **1 invented row against 32**. On the big
repositories it is also 40% cheaper and 48% faster. On small ones it is 22% dearer.

So: **ask the graph what breaks. Ask grep who calls.**

### The accuracy claim this page used to make, and why it is gone

Until August 2026 the table above read `51` invented for grep and `19` for p-graph, and this page
said p-graph invents a third as many. Both numbers were wrong, and one truth list caused it.

`caddy-handler-servehttp` asks for every call to the two-argument `ServeHTTP` declared by caddy's
`Handler` interface. Its truth list held 34 call sites. The repository has **51**: `metrics_test.go`
calls that exact method eighteen times, through `ih := newMetricsInstrumentedRoute(…)` whose type
declares `ServeHTTP(w, r) error` at `metrics.go:314`, and the list carried one of the eighteen.

So the 17 rows a run that grep was scored as inventing were real call sites. It had invented nothing.
And p-graph, which lists 34 of the 51, was scored as perfect — the short list hid the miss exactly
because it stopped where p-graph stops.

How it was caught is the part worth keeping: **a third arm was added, and it named the same lines grep
named.** This page's own rule says that when more than one arm names a line the truth does not have,
doubt the truth. Two arms agreeing was the signal; reading the eighteen lines settled it.

That makes four truth lists in this study that were short on the first pass. The other three were
found the same way. **Ground truth, not the tool, is the fragile part of this method.**

Every one of the 52 questions was then re-audited for the same defect, with the scorer's own match
rule, looking for any line two arms name that the truth lacks. Five lines in four questions came up,
all on follow-the-calls questions, all real calls sitting just outside the question's stated bound —
two more calls to `RemoveObsoleteFiles` that do not lie on the path from `Open`, a third use of
`secureRequestDump` inside a test file when the question says outside test files, and two rows one hop
further out than any row in their list. Those are now `neutral`: they count for neither side. After
that the audit is clean.

How big is "noise" here? We re-ran the untouched baseline arm on the C++ questions, changing nothing
about it, and its own cost moved 18% and its time 16% between the two passes. That is the yardstick
for every gap on this page.

## By language

Three repositories per language. Three runs each side — 186 runs.

| Language | Repos | Questions | Call sites found, grep / p-graph | Invented | Cost, grep / p-graph | Time, grep / p-graph | Cost gap |
|---|---|---:|---|---|---|---|---|
| Go | hugo, caddy, gin | 6 | 331 of 336 / **334 of 336** | 51 / **17** | $0.300 / **$0.251** | 65 s / **51 s** | **−16%** |
| Python | flask, requests, httpx | 5 | 135 of 135 / 135 of 135 | 0 / 0 | $0.181 / **$0.171** | 34 s / **30 s** | **−5%** |
| C++ | leveldb, re2, spdlog | 9 | 476 of 480 / **477 of 480** | 0 / 0 | **$0.301** / $0.327 | **52 s** / 58 s | **+9%** |
| TypeScript | nest, got, axios | 9 | **459 of 459** / 446 of 459 | **0** / 2 | $0.166 / **$0.155** | 25 s / 25 s | **−7%** |

Go and Python win on every axis at once. C++ buys the best recall of the four and pays 9% more for it.
TypeScript wins on money, steps and searches, and still loses 13 call sites — 10 on axios and 3 on got.

Two of the four rows here were ties or losses one round ago. Python was a clean tie until p-graph
learned to read the annotations Python writes. TypeScript lost steps, tokens and context until
p-graph learned to read a plain `.js` file at all. See "The Python round" and "The JavaScript round".

Every language except Python carries more than three questions, always for the same reason: the first
three were a free function or a call on a plain local, the shapes that already worked, so no fix to the
shape the language actually writes could have shown up here at all. Each extra question was written,
with its ground truth, BEFORE a line of code changed. See "Reading the value call", "The TypeScript
round", "The Go round" and "The Python round".

Every question, both sides. `found` and `invented` are totals over those runs; everything else is per
question. `text searches` counts Grep and grep through Bash — the graph query is not a search. The gap
column is a percentage throughout, and the last row is a share, so its gap is in percentage points.


```text
Go — 6 questions on hugo, caddy and gin, 3 runs a side

┌──────────────────────────────────────────────┬─────────────┬──────────────┬──────────────┬─────────┐
│ What we measured                             │ grep        │ p-graph      │ Gap          │ Winner  │
├──────────────────────────────────────────────┼─────────────┼──────────────┼──────────────┼─────────┤
│ "who calls X" — call sites found             │ 331 of 336  │ 334 of 336   │ +1%          │ p-graph │
├──────────────────────────────────────────────┼─────────────┼──────────────┼──────────────┼─────────┤
│ "who calls X" — call sites invented          │ 51          │ 17           │ -67%         │ p-graph │
├──────────────────────────────────────────────┼─────────────┼──────────────┼──────────────┼─────────┤
│ "who calls X" — cost                         │ $0.300      │ $0.251       │ -16%         │ p-graph │
├──────────────────────────────────────────────┼─────────────┼──────────────┼──────────────┼─────────┤
│ "who calls X" — time                         │ 65 s        │ 51 s         │ -23%         │ p-graph │
├──────────────────────────────────────────────┼─────────────┼──────────────┼──────────────┼─────────┤
│ "who calls X" — tool calls                   │ 7.9         │ 6.8          │ -13%         │ p-graph │
├──────────────────────────────────────────────┼─────────────┼──────────────┼──────────────┼─────────┤
│ "who calls X" — output tokens / context read │ 8609 / 850k │ 17748 / 699k │ +106% / -18% │ grep    │
├──────────────────────────────────────────────┼─────────────┼──────────────┼──────────────┼─────────┤
│ "who calls X" — text searches                │ 3.8         │ 1.9          │ -50%         │ p-graph │
├──────────────────────────────────────────────┼─────────────┼──────────────┼──────────────┼─────────┤
│ "what breaks if X changes" — cost            │ $0.86       │ $0.42        │ -51%         │ p-graph │
├──────────────────────────────────────────────┼─────────────┼──────────────┼──────────────┼─────────┤
│ "what breaks if X changes" — time            │ 237 s       │ 91 s         │ -62%         │ p-graph │
├──────────────────────────────────────────────┼─────────────┼──────────────┼──────────────┼─────────┤
│ "what breaks if X changes" — steps           │ 50          │ 7            │ -85%         │ p-graph │
├──────────────────────────────────────────────┼─────────────┼──────────────┼──────────────┼─────────┤
│ Answers that admit their own limits          │ 17% (3/18)  │ 44% (8/18)   │ +28 pts      │ p-graph │
└──────────────────────────────────────────────┴─────────────┴──────────────┴──────────────┴─────────┘
```

The only language that wins every row. Five of its six questions are level or near it — those are the
package-level functions and plain receivers that always worked. The sixth,
`caddyhttp.Handler.ServeHTTP`, is where the size of this box comes from: it is the most expensive
question in the study on both sides ($1.07 against $0.83, 229 s against 185 s), and the only one where
either side invents call sites in bulk. The output-token row is its doing too — p-graph's answers on it
list far more rows, because they list them right. See "The Go round".


```text
Python — 5 questions on flask, requests and httpx, 3 runs a side

┌──────────────────────────────────────────────┬─────────────┬─────────────┬────────────┬─────────┐
│ What we measured                             │ grep        │ p-graph     │ Gap        │ Winner  │
├──────────────────────────────────────────────┼─────────────┼─────────────┼────────────┼─────────┤
│ "who calls X" — call sites found             │ 135 of 135  │ 135 of 135  │ +0%        │ tie     │
├──────────────────────────────────────────────┼─────────────┼─────────────┼────────────┼─────────┤
│ "who calls X" — call sites invented          │ 0           │ 0           │ 0%         │ tie     │
├──────────────────────────────────────────────┼─────────────┼─────────────┼────────────┼─────────┤
│ "who calls X" — cost                         │ $0.181      │ $0.171      │ -5%        │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼────────────┼─────────┤
│ "who calls X" — time                         │ 34 s        │ 30 s        │ -12%       │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼────────────┼─────────┤
│ "who calls X" — tool calls                   │ 4.0         │ 3.5         │ -13%       │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼────────────┼─────────┤
│ "who calls X" — output tokens / context read │ 2979 / 365k │ 4029 / 352k │ +35% / -4% │ grep    │
├──────────────────────────────────────────────┼─────────────┼─────────────┼────────────┼─────────┤
│ "who calls X" — text searches                │ 2.6         │ 0.6         │ -77%       │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼────────────┼─────────┤
│ Answers that admit their own limits          │ 0% (0/15)   │ 47% (7/15)  │ +47 pts    │ p-graph │
└──────────────────────────────────────────────┴─────────────┴─────────────┴────────────┴─────────┘
```

Every row p-graph can win, it wins. Only output tokens go the other way, and that row does not pay the
bill — see the note on cache reads below.

`RequestsCookieJar.update` is the shape a graph is for: one real call site, and `.update(` matches a
dict on every second line. grep ran **6.3 searches** there against p-graph's 1.0, and both got it right.

Read the cost and time rows with the noise floor in mind. −5% and −12% are single-digit standard
errors on five questions; the baseline arm's own cost moved 18% between two identical passes. What is
not noise is the search row — 0.6 against 2.6 — and the three banners the round below rewrote, which
are facts about the graph and do not depend on the run at all.


```text
C++ — 9 questions on leveldb, re2 and spdlog, 3 runs a side

┌──────────────────────────────────────────────┬──────────────┬───────────────┬─────────────┬─────────┐
│ What we measured                             │ grep         │ p-graph       │ Gap         │ Winner  │
├──────────────────────────────────────────────┼──────────────┼───────────────┼─────────────┼─────────┤
│ "who calls X" — call sites found             │ 476 of 480   │ 477 of 480    │ +0%         │ p-graph │
├──────────────────────────────────────────────┼──────────────┼───────────────┼─────────────┼─────────┤
│ "who calls X" — call sites invented          │ 0            │ 0             │ 0%          │ tie     │
├──────────────────────────────────────────────┼──────────────┼───────────────┼─────────────┼─────────┤
│ "who calls X" — cost                         │ $0.301       │ $0.327        │ +9%         │ grep    │
├──────────────────────────────────────────────┼──────────────┼───────────────┼─────────────┼─────────┤
│ "who calls X" — time                         │ 52 s         │ 58 s          │ +11%        │ grep    │
├──────────────────────────────────────────────┼──────────────┼───────────────┼─────────────┼─────────┤
│ "who calls X" — tool calls                   │ 9.2          │ 8.2           │ -11%        │ p-graph │
├──────────────────────────────────────────────┼──────────────┼───────────────┼─────────────┼─────────┤
│ "who calls X" — output tokens / context read │ 13072 / 905k │ 11411 / 1077k │ -13% / +19% │ p-graph │
├──────────────────────────────────────────────┼──────────────┼───────────────┼─────────────┼─────────┤
│ "who calls X" — text searches                │ 5.1          │ 3.0           │ -41%        │ p-graph │
├──────────────────────────────────────────────┼──────────────┼───────────────┼─────────────┼─────────┤
│ Answers that admit their own limits          │ 4% (1/27)    │ 37% (10/27)   │ +33 pts     │ p-graph │
└──────────────────────────────────────────────┴──────────────┴───────────────┴─────────────┴─────────┘
```

It used to be **+77% cost and +117% time**; it is now +9% and +11%, and it buys the best recall of the
four languages. Seven of its nine questions are level. The remaining 9% is one question,
`re2::Prog::size` — $1.11 against $1.46, 213 s against 266 s. That question is also the one that
withdrew this page's old "+22 call sites" claim: grep scored 57 of 75 in one pass and 75 of 75 in the
next, and paid for the difference. See "The four C++ fixes" and "The third-repository round".


```text
TypeScript — 9 questions on nest, got and axios, 3 runs a side

┌──────────────────────────────────────────────┬─────────────┬─────────────┬───────────┬─────────┐
│ What we measured                             │ grep        │ p-graph     │ Gap       │ Winner  │
├──────────────────────────────────────────────┼─────────────┼─────────────┼───────────┼─────────┤
│ "who calls X" — call sites found             │ 459 of 459  │ 446 of 459  │ -3%       │ grep    │
├──────────────────────────────────────────────┼─────────────┼─────────────┼───────────┼─────────┤
│ "who calls X" — call sites invented          │ 0           │ 2           │ —         │ grep    │
├──────────────────────────────────────────────┼─────────────┼─────────────┼───────────┼─────────┤
│ "who calls X" — cost                         │ $0.166      │ $0.155      │ -7%         │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — time                         │ 25 s        │ 25 s        │ -3%         │ tie     │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — tool calls                   │ 4.8         │ 3.2         │ -33%        │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — output tokens / context read │ 4827 / 353k │ 3672 / 316k │ -24% / -11% │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ "who calls X" — text searches                │ 2.7         │ 0.3         │ -89%        │ p-graph │
├──────────────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│ Answers that admit their own limits          │ 0% (0/27)   │ 41% (11/27) │ +41 pts     │ p-graph │
└──────────────────────────────────────────────┴─────────────┴─────────────┴─────────────┴─────────┘
```

Every row p-graph can win, it wins, and the two token rows that were grep's a round ago are now the
widest margins in the box. The time row was measured three times to get here — see "The JavaScript
round" and "Reading what TypeScript writes".

What still goes grep's way is recall: p-graph loses 13 call sites of 459, **10 on `AxiosHeaders.has`
in axios and 3 on `Options.merge` in got**. On `Options.merge` the graph's own answer is complete and
correct — one run of the agent dropped three rows out of eighteen. On `AxiosHeaders.has` the graph
hands over 24 of the 26 call sites as certain rows, and the agent still reports about 23. That last
gap is the agent, not the index, and this study has no fix for it.

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
repo being small; it was defects in the resolver, and they are fixed. See "The four C++ fixes" and
"The third-repository round". C++ is now 9% dearer, and that 9% is one question.

The three token rows are there because they explain the money and they do not line up with it.
p-graph writes 30% more text than grep (10k output tokens against 7,678) and costs 1% less: at these
context sizes the bill is mostly cache reads, and those are within 1%. Writing is not what an extra
step costs — re-reading everything before it is.

**Where p-graph stands after three repositories per language.** On "who calls X" the money and the
time are a tie: $0.238 against $0.233, 44.0 s against 42.0 s, both under a standard error.
It invents a third as many call sites (51 against 19) and says what it might be missing ten times as
often. It takes 14% fewer steps. It loses 9 call sites of 1,410, all of them TypeScript. On the transitive question it is half
the cost and a seventh of the steps.

> **Withdrawn.** The invented counts in this paragraph — 51 and 19 — came from a truth list that was
> short by 17 rows. Corrected, grep invents 0 and p-graph 14, and the recall gap is 72 call sites, not
> 9. The paragraph is kept as the record of what that pass reported. See "The accuracy claim this page
> used to make, and why it is gone".

The search rows are the mechanism. On the list questions p-graph runs 1.6 text searches against grep's
3.7 — it needs fewer, but it still needs one now and then. Over every question the ratio is 1.5 to
4.3, because the transitive question alone makes grep run about twenty searches and p-graph one
`impact` call.

None of this was true several passes ago. p-graph used to run a text search on top of the graph query
on a list question, and that is where the money went.

## Question by question

The thirty-one "who calls X" questions. Three runs each side. First number is grep, second is
p-graph. The eleven that follow the calls instead are in "Following the calls" below.

| Question | Language | Real call sites | Call sites found | Invented | Cost | Time |
|---|---|---:|---|---|---|---|
| `caddyhttp.SanitizedPathJoin` in caddy | Go | 7 | 100% / 95% | 0 / 0 | $0.10 / **$0.08** | 17 s / 14 s |
| `helpers.Exists` in hugo | Go | 11 | 100% / 100% | 0 / 0 | $0.15 / $0.15 | 29 s / 29 s |
| `bufferpool.GetBuffer` in hugo | Go | 24 | 99% / 100% | 0 / 0 | $0.14 / $0.11 | 26 s / **15 s** |
| **`caddyhttp.Handler.ServeHTTP` in caddy** | Go | 34 | 99% / 99% | **17 / 5.7** | **$1.07 / $0.83** | 229 s / 185 s |
| `bytesconv.StringToBytes` in gin | Go | 14 | **93% / 100%** | 0 / 0 | $0.10 / $0.08 | 16 s / 13 s |
| `gin.Context.Render` in gin | Go | 22 | 100% / 100% | 0 / 0 | $0.24 / $0.24 | 74 s / **48 s** |
| `get_flashed_messages` in flask | Python | 6 | 100% / 100% | 0 / 0 | $0.19 / **$0.15** | 47 s / **21 s** |
| `RequestsCookieJar.update` in requests | Python | 1 | 100% / 100% | 0 / 0 | $0.30 / $0.28 | 58 s / 52 s |
| `super_len` in requests | Python | 16 | 100% / 100% | 0 / 0 | $0.12 / **$0.09** | 16 s / 14 s |
| `Response.raise_for_status` in httpx | Python | 12 | 100% / 100% | 0 / 0 | $0.14 / $0.16 | 19 s / 26 s |
| `Cookies.set` in httpx | Python | 10 | 100% / 100% | 0 / 0 | $0.15 / $0.18 | 30 s / 37 s |
| `TotalFileSize` in leveldb | C++ | 8 | 100% / 100% | 0 / 0 | $0.15 / **$0.10** | 10 s / 14 s |
| `WriteBatchInternal::Count` in leveldb | C++ | 11 | **91% / 100%** | 0 / 0 | $0.09 / $0.11 | 10 s / 11 s |
| `WriteBatchInternal::SetSequence` in leveldb | C++ | 7 | 100% / 100% | 0 / 0 | $0.09 / $0.13 | 9 s / 13 s |
| **`WriteBatch::Put` in leveldb** | C++ | 24 | 100% / 100% | 0 / 0 | **$0.31 / $0.10** | **68 s / 18 s** |
| `Insert` through `leveldb::Cache` | C++ | 4 | 100% / 100% | 0 / 0 | $0.17 / $0.17 | 28 s / 27 s |
| `re2::Regexp::Incref` in re2 | C++ | 38 | 99% / 99% | 0 / 0 | $0.26 / **$0.21** | 41 s / 40 s |
| **`re2::Prog::size` in re2** | C++ | 25 | 100% / 99% | 0 / 0 | **$1.11 / $1.46** | **213 s / 266 s** |
| `spdlog::details::os::create_dir` | C++ | 14 | 100% / 100% | 0 / 0 | $0.19 / $0.19 | 28 s / 35 s |
| `spdlog::sinks::sink::log` | C++ | 29 | 100% / 99% | 0 / 0 | $0.35 / $0.48 | 66 s / 99 s |
| `ClassSerializerInterceptor.serialize` in nest | TypeScript | 13 | 100% / 100% | 0 / 0 | $0.22 / **$0.13** | 26 s / 21 s |
| **`PipesContextCreator.create` in nest** | TypeScript | 4 | 100% / 100% | 0 / 0 | **$0.13** / $0.24 | **17 s** / 51 s |
| **`Serializer.serialize` in nest** | TypeScript | 20 | 100% / 100% | 0 / 0 | **$0.21 / $0.12** | **33 s / 14 s** |
| `extendArrayMetadata` in nest | TypeScript | 12 | 100% / 100% | 0 / 0 | $0.08 / **$0.06** | 11 s / 11 s |
| `validateEach` in nest | TypeScript | 10 | 100% / 100% | 0 / 0 | **$0.07** / $0.10 | 13 s / **11 s** |
| `Request._beforeError` in got | TypeScript | 25 | 100% / 100% | 0 / 0 | **$0.11** / $0.15 | 20 s / 23 s |
| `Options.merge` in got | TypeScript | 18 | **100% / 94%** | 0 / 0 | $0.22 / **$0.20** | 37 s / **28 s** |
| **`AxiosHeaders.has` in axios** | TypeScript | 26 | **100% / 87%** | **0 / 0.7** | $0.26 / **$0.23** | 45 s / **41 s** |
| `InterceptorManager.eject` in axios | TypeScript | 25 | 100% / 100% | 0 / 0 | $0.19 / **$0.16** | 27 s / **23 s** |
| `byteCountFlexiWriter.WriteRune` — nothing calls it | Go | 0 | — | 0 / 0 | $0.23 / $0.28 | 59 s / 62 s |
| **What breaks if `bufferpool.GetBuffer` changes** | Go | not scored | — | — | **$0.86 / $0.42** | **237 s / 91 s** |

Read the last row apart from the rest. It is the only question grep cannot answer in one step.

### The thirty "who calls X" questions, with the noise floor

Printed by `measure-agent.mjs --score`, not worked out by hand. Thirty, not twenty-nine: the trap
question — a symbol nothing calls — is a "who calls X" question too, and it is the one where an empty
answer is the right answer.

| | grep | p-graph | Difference | Noise floor |
|---|---|---|---|---|
| Call sites found | **1401 of 1410** | 1392 of 1410 | −9 | — |
| Call sites invented | 51 | **19** | −63% | — |
| Cost per question | $0.238 | $0.233 | −2% | ±$0.018 on −$0.005 — **0.3 SE** |
| Time per question | 44.0 s | 42.0 s | −5% | ±3.7 s on −2.0 s — **0.5 SE** |
| Steps per question | 7.7 | **6.6** | −14% | ±0.4 on −1.0 — **2.6 SE** |

**Cost and time are noise; steps is not.** 0.3 and 0.5 standard errors are not differences. Steps at
2.6 SE is one, by the same bar this page has used throughout. At 19 questions in seven repositories
this table read −21%, −22% and −24% and steps also crossed two SE — and none of it survived the set
growing. The claim now standing is the smallest of the three, on the biggest set, and it is made after
the rounds that stopped p-graph creating work for itself. It is the one row to re-check first when a
thirteenth repository is added.

The floor is wide because the questions are not the same size — one costs grep $1.11 and the smallest
$0.09 — so the per-question table above carries more than this average does.

Accuracy is not a tie either way, and it now points at grep by nine call sites of 1,410. All nine are
TypeScript. p-graph still invents a third as many: 19 against 51.

> **Withdrawn**, for the reason given at the top of this page: those invented counts rest on a truth
> list that was short by 17 rows. Corrected, grep invents 0 and p-graph 14.

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
study at that round the count was 21 of 57 against grep's 6; at three repositories per language it is
42 of 93 against 7.

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

In the A/B of that round, TypeScript went from the only language p-graph lost to one that won every
row. It did not hold: adding axios as a third repository took the win back — see "The
third-repository round".

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

**Python read no type annotations at all.** That was the clearest hole the third round opened, and it
was not C++. It is fixed in the round below.

## The Python round

Python was the last language still tying. Its cost row read −2% and its time row +3%, which is a tie,
and it lost the tool-call, output-token and context rows outright.

### One question owned the whole loss

Four of the five questions were already level or a win. The fifth was not:

| Question | steps grep · p-graph | searches | time |
|---|---|---|---|
| flask `get_flashed_messages` | 2.3 · **2.0** | 1.0 · **0.0** | 14 · 14 s |
| requests `RequestsCookieJar.update` | 13.0 · **11.0** | 9.7 · **1.0** | 74 · **59 s** |
| requests `super_len` | 2.7 · **2.0** | 1.0 · **0.0** | 16 · **14 s** |
| httpx `Response.raise_for_status` | **3.3** · 4.0 | **1.7** · 1.0 | **22** · 28 s |
| **httpx `Cookies.set`** | **5.0** · 10.0 | **2.0** · 4.3 | **27** · 43 s |

Twice the steps and twice the searches, for a question both sides answered perfectly — 10 of 10 call
sites each. The extra work was the ⚠ banner: **7 rows, and not one of them a call of `Cookies.set`.**
Reading them one at a time is what found the round:

| Row | What it really is | Why the graph could not tell |
|---|---|---|
| `asgi.py:167`, `:175` | `response_complete.set()`, and `def create_event() -> Event` where Event is asyncio's | `-> T` was never read |
| `_urls.py:343` | `self.params.set(…)` → `QueryParams.set`, a real method of another class | `self.<field>.<method>()` carried no key at all |
| `conftest.py:252` | `self.restart_requested.set()`, the field holds an `asyncio.Event()` | field types were never read |
| `test_queryparams.py:104` | `q = QueryParams(…)` then `q = q.set(…)` | the second binding conflicts the first and both are dropped |
| `test_queryparams.py:136`, `test_url.py:450` | `set(params)` — the **builtin** | Python had no builtin list |

### What was wrong

Everything in that table is one fact: **for Python, the only thing extraction wrote into `field_types`
was `x = Call()`.** Every `def f(self, r: Response)`, every `x: Response = …`, every
`self.jar: Cookies` and every `def get(…) -> Response` was skipped. Go, TypeScript and C++ each read
the types their language writes; Python did not.

### What was changed

| | Change |
|---|---|
| 1 | A Python builtin list, the last of the four languages to get one. `set(xs)` is now marked external, and a repo that declares its own `def set` still wins — resolved by a new pass, the same two-step Go uses for `max`. |
| 2 | Type annotations are read: on a parameter, on a variable, on a class field, and `-> T` on a def. A forward reference in quotes counts; a subscript like `Optional[X]` does not, because recording the wrong type deletes real rows. |
| 3 | `self.<field>.<method>()` is keyed, the shape Python writes most and the one shape TypeScript and C++ had and Python did not. Field types come from `self.x = C()`, from `self.x: C`, from a class-body annotation, and from an `@property` getter's return type. |
| 4 | `x = x.foo()` no longer writes a type row. It says "x is whatever x.foo returns", which needs x's type to work out — it can never resolve and it always conflicts. |
| 5 | `x = await f()` is read. The right-hand side is an `await` node, not a call, so nothing was recorded at all. |
| 6 | `with C() as x` gives x the type C, and a value the source builds from another value — `r = client.request()` — is followed one hop further: what is `client`, and what does that type's `request` return? |
| 7 | A receiver the source types outside the repo gets the `library` reason C++ already had, so the banner counts it in one line instead of listing it. |

### What it bought

The three banners, which are facts about the graph and carry no run-to-run noise at all:

| | before | after |
|---|---|---|
| `callers "Cookies.set"` | ⚠ 7 rows listed | **no ⚠ at all** — 3 library + 2 external, counted |
| `callers "Response.raise_for_status"` | ⚠ 2 listed, 3 guesses | **`✓ complete`**, 12 of 12, 10 of them certain |
| `callers "RequestsCookieJar.update"` | ⚠ 5 listed | **⚠ 1 listed** |

Member calls resolved with certainty:

| | flask | requests | httpx |
|---|---:|---:|---:|
| before | 5.8% | 17.4% | 20.8% |
| after | **6.4%** | **21.1%** | **31.2%** |

And in the A/B, Python went from a tie to winning every row it can win:

| | before | after |
|---|---|---|
| cost | $0.184 / $0.180 (−2%) | $0.181 / **$0.171** (−5%) |
| time | 31 s / 32 s (**+3%**) | 34 s / **30 s** (−12%) |
| tool calls | 4.3 / 4.8 (**+12%**) | 4.0 / **3.5** (−13%) |
| context read | 386k / 433k (**+12%**) | 365k / **352k** (−4%) |
| text searches | 3.1 / 1.3 | 2.6 / **0.6** |

Say the size of that honestly: at five questions, −5% on cost is a fraction of a standard error, and
the baseline arm's own cost moved 18% between two identical passes. The cost row is a tie that now
leans the right way, not a win. The rows that did change beyond doubt are the banners above, the
resolution shares, and the search count.

### What is still not fixed

- flask barely moved — 5.8% to 6.4%. Its `field_types` gains little because most of what flask calls
  is on a value nothing types: `self.__dict__`, a Werkzeug object, a local built from a dict.
- `Optional[Response]` and `A | B` are skipped. Taking the inner type of a subscript is a further
  step, and the cost of getting it wrong is a deleted real row, not a missing one.
- A field declared in a BASE class in another file is not found. TypeScript walks the extends chain
  for this; Python does not yet.
- Two bindings of one name to two different types still refuse both. Picking needs to know which line
  ran, which is flow analysis, not scope. 19 keys in httpx, 26 in requests, 16 in flask.

One measured side effect outside Python, recorded because it is the sort of thing this page exists to
catch: the one-hop follow in change 6 also applies to Go, and it reaches 818 unresolved calls in hugo,
291 in gin and 35 in caddy. Across the six Go questions it changed the **listed** rows on none of them
— `Handler.ServeHTTP` still lists 14, `Context.Render` still lists 2, three are still `✓ complete` —
and added one counted line to one question. C++ and TypeScript are untouched: 0 rows in all six repos.
Go was therefore not re-measured, and its numbers above are the ones the third-repository round
produced.

## The JavaScript round

TypeScript came out of the third-repository round as the only language p-graph still lost on: steps
+7%, output tokens +37%, context +14%. It also held the worst single answer on this page.

### The worst answer in the study

`callers "AxiosHeaders.has"` on axios came back with **no certain row, 18 guesses, and `✓ complete`**.
Both of those lines are in the installed rule, and they say opposite things — `✓ complete` means
"stop, do not grep", a guess means "open the `file:line` and read it". The run obeyed both, cost 12.7
steps against grep's 9.7, and still dropped 10 of the 26 real call sites and invented 2.

Reading the 18 rows found the round. Most were not calls of `AxiosHeaders.has` at all:

| Rows | Receiver | What it is |
|---|---|---|
| 6 | `visited`, `lowerKeys`, `LOOPBACK_HOSTNAMES` … | a `Set` or a `WeakSet`, several of them `new`-ed on the line above |
| 3 | docs scripts | unrelated code with a method of that name |
| 2 | `request.headers`, `sensitiveSet` | a fetch `Headers` and an untyped parameter — genuinely unreadable |
| rest | `headers` | the real thing, written `const headers = new AxiosHeaders()` one line above the call |

### What was wrong

`js.scm` had no rule for a variable. Not "JavaScript has no annotations" — no rule at all. ts.scm has
recorded what a name is bound to since the TypeScript round; the JavaScript query file never got the
same lines. So in a `.js` file p-graph recorded no binding and no type, every identifier receiver fell
through to the `#static:` key, matched no class of that name, and became a bare-name guess.

axios is 191 `.js` files against 23 `.ts`. The result:

| | member calls | resolved with certainty |
|---|---:|---:|
| axios | 7,940 | **9 — 0.1%** |
| got | 9,297 | 334 — 3.6% |
| nest | 19,703 | 3,751 — 19.0% |

0.1% is the lowest number in this study, and 5,160 of those calls were keyed `#static:` on what was
plainly a local variable.

### What was changed

| | Change |
|---|---|
| 1 | `js.scm` gets the variable rules. The parameter rule is the OPPOSITE of ts.scm's and has to be: in the JavaScript grammar a plain parameter is a bare identifier under `formal_parameters`, and `required_parameter` does not exist — a pattern the grammar cannot produce fails the whole query file, not just itself. |
| 2 | An answer whose every row is a guess no longer says `✓ complete`. It says `✓ no gaps — but every row above is a guess`, and `--json` gains `all_guessed`. `complete` itself is untouched: it is a claim about the gap report, and that claim was true. |
| 3 | `this.m()` inside an arrow function inside a method belongs to the class — an arrow does not rebind `this`. It does NOT belong to the class through a plain `function`, which does; that was a false certain row, and it is now refused. |
| 4 | `const x = a ?? new C()` and `\|\|` name the type, when the other side is a plain name or an empty value. Two constructors, or a ternary, still refuse. |

### What it bought

| | before | after |
|---|---|---|
| axios — certain member calls | 9 (0.1%) | **250 (3.1%)** |
| axios — guesses | 394 | 298 |
| got — certain | 334 (3.6%) | 348 (3.7%) |
| nest — certain | 3,751 (19.0%) | 3,798 (19.3%) |
| `callers "AxiosHeaders.has"` | 0 certain, 18 guesses, `✓ complete` | **11 certain rows covering 24 call sites**, 2 guesses, 6 counted as library |
| `callers "Request._beforeError"` | 21 certain + 4 guess entries | 24 certain, **1 guess entry** |

In the A/B, every row TypeScript was losing turned over:

| | before | after |
|---|---|---|
| cost | $0.177 / $0.171 (−3%) | $0.167 / **$0.156** (−7%) |
| tool calls | 4.5 / 4.8 (**+7%**) | 4.6 / **3.4** (−24%) |
| output tokens | 4610 / 6304 (**+37%**) | 4161 / 4394 (+6%) |
| context read | 355k / 406k (**+14%**) | 361k / **342k** (−5%) |
| text searches | 2.3 / 1.2 | 3.1 / **0.7** |
| `AxiosHeaders.has` | 12.7 steps / $0.24 → 16.7 steps / $0.31 | **12.7 → 4.3 steps**, $0.30 → **$0.19** |

### The time row was measured twice, and the first pass is discarded

The first graph-arm pass came back at **74 s a question against grep's 40**, an 82% loss, while cost
fell 14% and tool calls 33%. Those cannot all be true. Six of its 27 runs sat at 127–222 seconds
having taken **one or two steps** — a stalled request, not work. The arm was re-run: 33 s a question,
no run over 132 s, and the longest ones are the ones with the most steps.

Both numbers are here on purpose. The grep arm of that pass carries one 241-second stall of its own,
so the −18% time gap above is worth less than the rows that agree with each other, and this page has
already withdrawn two claims for less.

### What is still not fixed

- axios sits at 3.1% certain. Better than 0.1% by a factor of 28 and still the worst of the six
  repositories. A plain `.js` codebase types almost nothing, and a receiver that arrives as a
  parameter or off a chain has nothing to read.
- The 13 lost call sites did not move. On `Options.merge` the graph is right and one agent run dropped
  three rows; on `AxiosHeaders.has` the graph hands over 24 of 26 certain and the agent reports about
  23. Neither is an index problem, and this study does not know how to fix an agent.
- A `#static:` receiver that names an imported value rather than a repo class is still guessed:
  `Test.createTestingModule(...)` in nest is @nestjs/testing's `Test`, 255 rows of it. Measured as 6
  guessed calls after deduplication, which is why it was not done.

## Reading what TypeScript writes

The round above fixed the `.js` half of the language and left the `.ts` half where it was. Three
questions still cost p-graph more steps than grep, and reading them found one omission that was
larger than all of them.

### TypeScript read no return types at all

| | rows in `field_types` keyed `#ret` |
|---|---:|
| nest | **0** |
| got | **0** |
| axios | **0** |

Go has read a function's declared result since the first version and Python since the round before
this one. TypeScript — the language that writes a return type more often than either — read none. The
resolver pass that follows them is language-agnostic; its query simply said `lang IN ('go','py')`, and
extraction never wrote the rows for it to find.

### Two smaller things next to it

**A call written on an imported name was guessed.** `Test.createTestingModule(...)` is
@nestjs/testing's `Test`. No repo class carries the name, so the bare-name fallback answered it with
whatever single repo symbol shared the method name: **264 such calls in nest**, 13 in axios, 1 in got.
The import statement says outright that the value is not this repo's.

**A decorated constructor parameter property was skipped.** `constructor(private readonly svc: Svc)`
declares a field and a parameter in one line, and the rule that reads it had been there since the
TypeScript round. It checked for the modifier on the parameter's FIRST child — and nest writes
`@InjectModel(Cat.name) private readonly catModel: Model<Cat>`, where a decorator holds that place. So
the field row was never written and the type went in under the parameter's own key, where no call site
looks. 157 calls in nest, and it was every row the ⚠ banner of `PipesContextCreator.create` still
listed.

### What was changed

| | Change |
|---|---|
| 1 | Read `-> T` on a TypeScript def into `<qname>#ret`, and let Pass R see `ts` and `js`. `Promise<T>` is unwrapped: an async function is annotated that way and the value every caller uses is the awaited one, while a Promise's own methods are `then` and `catch`, which no repo class answers. A union or an inline object type names no single type and is refused. |
| 2 | A call on a name this file imports is marked external, the same mark `JSON.parse` already carried. A repo class of that name still wins, exactly as a Go package that declares its own `max` wins over the builtin. |
| 3 | The modifier on a constructor parameter property may sit behind a decorator. |

One thing had to be decided rather than copied. A `#ret:` marker means "the type is decided by a
callee", and Go and TypeScript want opposite things from it. For Go, failing to resolve the callee is
evidence — the value is not this repo's — and refusing the bare-name guess there was the largest
single cut in false rows this study has made. For TypeScript the same refusal had already been
measured as a loss: `const module = await Test.createTestingModule(…).compile()` is everywhere in
nest, nothing can read what it returns, and refusing threw away 190 rows that were all correct. So for
TypeScript the marker is skipped **only when nothing at all could be learned about the callee**. When
the callee does declare a result and it simply is not a repo class, that is evidence and the refusal
stands. Both halves are under test.

### What it bought

| | before | after |
|---|---|---|
| `#ret` rows (nest / got / axios) | 0 / 0 / 0 | **534 / 78 / 2** |
| nest — guesses | 906 | **630** |
| nest — certain member calls | 3,798 | 3,856 |
| axios — guesses | 298 | 286 |
| `callers "PipesContextCreator.create"` — listed rows | 7 | **4** (library counter 22 → 25) |

In the A/B, the two token rows crossed over and the step gap widened:

| | before this round | after |
|---|---|---|
| cost | $0.167 / $0.156 (−7%) | $0.166 / $0.155 (−7%) |
| tool calls | 4.6 / 3.4 (−24%) | 4.8 / **3.2** (−33%) |
| output tokens | 4161 / 4394 (**+6%**) | 4827 / **3672** (−24%) |
| context read | 361k / 342k (−5%) | 353k / **316k** (−11%) |
| text searches | 3.1 / 0.7 | 2.7 / **0.3** |

Across all 30 questions the step gap went from −12% at 2.2 SE to **−14% at 2.6 SE**.

Read the return-type fix honestly, though: it wrote 534 rows in nest and only 58 of them turned into a
new certain edge. The 276 guesses that disappeared are almost entirely the imported-name fix, which
took four lines. The biggest-looking omission was not the biggest win.

### What is still not fixed

- **got gained nothing.** Its 78 `#ret` rows connected to nothing, because its untyped variables are
  bound to calls whose callee is not a plain name.
- Two questions still cost more steps than grep. `PipesContextCreator.create` (4.3 → 7.3) still lists
  4 rows, and `Request._beforeError` (3.0 → 4.3) has one guess left —
  `const {gotRequest} = requestOptions as any`, where there is nothing to read.
- `axios.interceptors.response.eject(...)` is a two-level chain off an object literal
  (`this.interceptors = {request: new InterceptorManager(), …}`). 2,433 chain calls across the three
  repos wait behind that shape.

## Following the calls

Thirty of the thirty-one questions above are one shape — "list every call site" — and it is the shape
grep is best at. The question a graph exists for was asked once, on hugo, and could not be scored.
Eleven more were written and scored: five "what breaks if I change X", three "how does X reach Y", one
"what does X end up calling", one "is this still used", across Go, Python and C++.

**The answer splits clean in two, and the split is the size of the repository.**

| 9 questions on gin (80 files), leveldb (132), flask, requests | grep | p-graph | |
|---|---|---|---|
| cost | **$0.190** | $0.239 | +25% |
| time | **32 s** | 50 s | +55% |
| steps | **5.7** | 6.8 | +18% |
| call sites found | 89 of 114 | **95 of 114** | |
| invented | 12 | **5** | |

| 2 questions on caddy (325 files) and hugo (905) | grep | p-graph | |
|---|---|---|---|
| cost | $0.770 | **$0.371** | **−52%** |
| time | 192 s | **86 s** | **−55%** |
| steps | 21.8 | **8.0** | **−63%** |
| call sites found | 39 of 45 | **44 of 45** | |
| invented | 24 | **3** | |

On a small repository the chain often lives in one file. grep opens it once and sees the whole thing;
the graph pays a query per hop. Measured on gin's `Recovery`, where every function in the chain is in
`recovery.go`: 2 tool calls for grep against 9 for the graph. On hugo the same shape goes the other
way, and not by a little:

| `isGitModule` in hugo — what would have to change | grep | p-graph |
|---|---|---|
| call sites found | 9 of 15 | **15 of 15** |
| **invented** | **21** | **0** |
| cost | $1.06 | **$0.30** |
| time | 278 s | **69 s** |
| steps | 27.0 | **7.7** |

grep invented 21 rows against 15 real ones — more than half of its answer was not true. That is the
whole argument for a graph in one number: a text search returns occurrences of a string, and on a
905-file repository working out what each one meant is where the money goes.

### What "big" and "small" actually are

Every repository in the study, measured the same way — read out of its own graph, so the counts are
what p-graph indexed and not what `find` happens to see. Bold rows are the ones the split above
stands on.

| Repository | Language | Files | Symbols | Call edges |
|---|---|---:|---:|---:|
| nest | TypeScript | 1,728 | 13,037 | 38,315 |
| **hugo** | Go | **930** | 10,314 | 55,499 |
| **caddy** | Go | **326** | 3,656 | 23,642 |
| axios | JavaScript | 240 | 3,462 | 14,343 |
| spdlog | C++ | 152 | 2,563 | 8,239 |
| **leveldb** | C++ | **132** | 2,155 | 9,241 |
| **gin** | Go | **99** | 1,552 | 9,191 |
| re2 | C++ | 89 | 1,760 | 8,273 |
| got | TypeScript | 85 | 3,505 | 14,329 |
| **flask** | Python | **83** | 1,619 | 3,905 |
| httpx | Python | 60 | 1,241 | 4,188 |
| **requests** | Python | 37 | 807 | 2,684 |

The line falls between leveldb and caddy: 132 files against 326, and — the widest gap of the three
measures — **9,241 call edges against 23,642**. Call edges are the honest yardstick here, because they
are what a chain is walked through.

**The flip was only ever observed inside Go.** Both big points are Go repositories, and that has to be
said plainly:

| Language | small points | big points |
|---|---|---|
| Go | gin 99 | **caddy 326, hugo 930** |
| Python | flask 83, requests 37 | none |
| C++ | leveldb 132 | none |
| TypeScript | none | none |

So the claim this page can support is: *on Go, following the calls flips from grep's favour to
p-graph's somewhere between 9k and 24k call edges.* Whether Python and C++ turn over at the same size
is untested — neither has a follow-the-calls question on a big repository — and TypeScript has no
question of this shape at all, for the reason given below. Two data points are two data points; the
direction is not in doubt, and the threshold is not established.

### How the truth was built, and what has none

Every list was walked by hand with grep, one name at a time, and every hop was read. That is slow, and
unreliable for exactly the reason p-graph exists: a bare-name walk through leveldb's `Evict` came back
with 52 "callers" and through `UpdateStats` with 116, nearly all of them different methods sharing a
name. One walk even matched `"multiple addresses (upstream …)"` inside a string literal and put a
health-check function into caddy's import graph.

So targets were chosen to make the truth PROVABLE, not to make the questions hard: the name is unique
in the repository, the chain closes within a few hops or the question names its own bound, and tests
and examples are out. A chain that runs through `Get`, `Next`, `Seek` or a constructor has no truth
this method can settle, and none was included on a guess.

**TypeScript has no question of this shape.** nest, got and axios are written in classes, the chains
run through methods, and working out which method holds a call could not be made reliable enough to
close a truth list. An incomplete truth list scores a correct answer as invented, so nothing was
written rather than something shaky.

## What that means

- **For "who calls X", grep is still the more accurate of the two, but the gap has mostly closed.**
  1,674 call sites of 1,683 against 1,650, and grep invents none where p-graph invents 14. Cost and
  time now lean p-graph's way. p-graph still wins the one shape a text search cannot do — a call
  written without a qualifier from inside the class that owns the method, which grep missed in all
  three runs — but that is one question, and the total still goes grep's way. The gap used to be 72
  sites and was mostly `caddy-handler-servehttp` (104 of 153); fixed 28 August, that question now
  reads 152 of 153, and `axios-eject` (51 of 75) is what is left of the 33-site gap. See "Why Go
  moved" and "By language".
- **The plugin earns its keep on a big repository, and not on a small one.** That is the clearest line
  this study has produced, and it is the one to read first. On the eleven questions that follow the
  calls, split by the size of the repository:

  | | cost | time | steps | invented |
  |---|---|---|---|---|
  | gin 80 files, leveldb 132, flask, requests | grep **25% cheaper** | grep **55% faster** | grep **18% fewer** | 12 → **5** |
  | caddy 325 files, hugo 905 | p-graph **52% cheaper** | p-graph **55% faster** | p-graph **63% fewer** | 24 → **3** |

  Accuracy goes p-graph's way in both. Money and time only above some size between 132 files and 325.
  On hugo the single question ran $1.06 against $0.30 and 27 steps against 7.7, and grep invented 21
  call sites against 15 real ones. See "Following the calls".
- **For "what breaks if I change X", use p-graph — on a repository big enough to need it.** Half the
  cost, a third of the time, a seventh of the steps, and one `impact` call instead of a hand-walked
  call tree.
- **The reason to install it is the honesty, not the speed.** 70 answers of 156 said what they might be
  missing, against 4 of 156. That is the gap banner and the guess marking being relayed, and grep has
  no equivalent.
- **On the follow-the-calls shape, and only there, p-graph is also the more accurate.** 187 call sites
  of 216 against 180, and **1 invented row against 32** — 26 of grep's 32 on the big repositories,
  where a text search has to guess what each hit meant. This is the claim the "who calls X" tables
  cannot support and this shape can.
- **A tool that makes you run one more command is not a fast tool.** In the first round the whole 48%
  gap was one extra query, caused by `callers` answering a different question from the one it was
  asked.

## Where the graph still earns its place

Besides the transitive question, one more number came out clearly for the plugin. An answer is worth
more when it says what it does not know, and p-graph said so far more often:

| | Runs whose answer flags its own limits |
|---|---|
| p-graph | **70 of 156** |
| grep | 4 of 156 |

That is the gap banner and the `UNVERIFIED` marking doing their job — they are text the agent can
relay, and it does. A grep-only agent has nothing equivalent to relay.

## The third arm: a language server

grep is the floor, not the alternative. A user deciding whether to install this plugin is choosing
between it and `gopls`, `clangd`, `pyright` or `typescript-language-server` — and this page could not
speak to that at all, because the runner switches the machine's Go LSP off in **both** arms on
purpose. Without that, `gopls` would have answered the Go questions in the grep arm and voided the
comparison.

So a third arm was built: the same clones, the same questions, the same model, the official language
server plugins and the built-in `LSP` tool, and a rule written to the same standard as the p-graph
rule. All four languages have now run — six Go questions on caddy and hugo, nine TypeScript questions on
nest, got and axios, twelve Python questions on requests, flask, httpx and django, and fifteen C++
questions on leveldb, re2, spdlog and rocksdb. Three runs a side each.

| 4 list questions + 1 trap | grep | p-graph | gopls |
|---|---|---|---|
| Call sites found | 277 of 279 | **277 of 279** | **279 of 279** |
| Call sites invented | 0 | 0 | 0 |
| Cost per question | $0.337 | **$0.240** | $0.357 |
| Time per question | 72 s | **45 s** | 78 s |
| Steps per question | 10.8 | **8.8** | 17.1 |
| Tool calls per question | 6.6 | **5.3** | 16.9 |
| `caddy-addnode-impact` — steps | 16.7 | 12.3 | 28.7 |

> **Withdrawn.** This box used to read p-graph short by a third — 229 of 279, against grep's 277 and
> gopls's 279 — and the paragraph below said the language server "answered every call site of every
> question" and was "the most accurate of the three." Neither holds any more. `callers` on a Go
> interface method now also reports the calls that run through an implementation of it, and p-graph
> reads 277 of 279 here: level with grep, 2 short of gopls, at a third less cost than either. See
> "Why Go moved" below for what changed and why it took two fixes, not one.

**The language server is still the most expensive of the three in round trips, and it no longer has
sole claim to the most accurate.** gopls finds 2 more call sites of 279 than grep or p-graph, both of
which are now level with each other. That is what a type checker should do on Go, and it still does
it — but it costs about half again what p-graph pays, at about twice the steps.

What it costs is steps: 17.1 against p-graph's 8.8. The mechanism is the API. `LSP` is addressed by
file, line and character, so a list of N call sites costs about N calls, where a graph query costs
one. The tool breakdown shows the arm is not even pure LSP — 4.1 `LSP` calls a question and **5.3
greps**, because the agent opens the lines it is told about to check the receiver.

Two things decide when the graph still wins:

- **A language server needs the project to build.** Resolved Go modules, `npm install`, a C++
  `compile_commands.json`. On the machine this was measured on, C++ has no toolchain at all — no
  `cmake`, no `ninja`, no compiler — so clangd could not be run on rocksdb or leveldb, while p-graph
  indexes both from text. That is not a footnote; it is the whole reason a parser-based graph exists.
- **It walks a chain one request per hop.** 28.7 steps against p-graph's 12.3 on the transitive
  question, where `impact` answers in one call.

### Why Go moved

**The code.** `callers` on a method an interface declares now also reports the calls that run an
implementation of it. Before, `callers caddyhttp.Handler.ServeHTTP` named 1 of the 18 calls in
caddy's `modules/caddyhttp/metrics_test.go`; now it names 18. Separately, a Go interface declaring
several methods used to keep only its first — 13 caddy interfaces declared 31 methods and the graph
held 13; now 31. The same defect existed in TypeScript and was fixed too: nest's indexed
interface-method count went from 101 to 283.

**The wording, and it was worth as much as the code.** With the code fixed, the first re-measurement
came back with Go recall unchanged. The graph reported all 18 sites and the agent printed all 18 with
line numbers — under a heading it invented: *"Calls to the same 2-arg/error signature on a concrete
type that implements `Handler` (17 sites, tests only) … a concrete implementer of `Handler`, not the
interface value itself."* The extraction step took **1 of 18** from that answer, where it took 18 of
18 from the grep and server answers. The cause: the rule's table of "what this line means, what to
do" had a row for the older interface-reach heading and **no row for the new one**, so the agent had
nothing to follow and chose the cautious reading. Adding the row and rewording the heading took that
question from 104 to 152 of 153. That is the **fourth** time this study has found wording moving the
number more than code did — see "What we got wrong" for the other three.

### TypeScript: the server came last, and the project's own tsconfig says why

Nine questions on nest, got and axios, three runs a side, `typescript-language-server`.

| 9 list questions | grep | p-graph | tsserver |
|---|---|---|---|
| Call sites found | **459 of 459** | 431 of 459 | 413 of 459 |
| Call sites invented | 0 | 0 | 0 |
| Cost per question | **$0.166** | $0.170 | $0.259 |
| Time per question | **25 s** | 26 s | 45 s |
| Steps per question | 5.8 | **4.4** | 11.4 |
| `LSP` calls and greps per question | — | — | 2.4 and 2.1 |

On Go the server found every call site. On TypeScript it is the worst of the three. This is not a
broken install: the preflight proved tsserver resolves all three repositories before the first run,
and both misses below were then reproduced from the server directly, with no agent in between.

Forty of the 46 missing sites are in nest, and nest's own configuration explains them.

**A repository that splits itself into per-package projects hides callers in sibling packages.**
`PipesContextCreator.create` has four callers. Ask tsserver and it names two:

```
$ node scripts/lsp-probe.mjs --dir <nest> --command typescript-language-server \
    --refs packages/core/pipes/pipes-context-creator.ts:21:9 --args --stdio
2 references
  packages/core/helpers/external-context-creator.ts:114
  packages/core/router/router-execution-context.ts:112
```

The other two callers are in `packages/microservices` and `packages/websockets`. They import
`PipesContextCreator` from `@nestjs/core/pipes`, and nest ships nine per-package `tsconfig.json`
files, each with `"include": []` and a project reference. So that import resolves to the published
copy in `node_modules/@nestjs/core`, which is a different declaration from the source file. Move
those nine files aside and the same question returns all four — lines 114, 112, 82 and 74. The server
was right about the program it was given.

**A repository that keeps its tests out of type checking hides every test caller.**
`ClassSerializerInterceptor.serialize` has 13 callers: one in production code, 12 in a `.spec.ts`
file. tsserver answers one. nest's root `tsconfig.json` says
`"exclude": ["node_modules", "**/*.spec.ts"]`, so the spec file is not in the program at all.

Neither miss came with a warning. The server said "2 references" and "1 reference" in the same tone
it uses for a complete answer. Whether the agent recovers is luck: on `nest-serialize`, two runs of
three trusted the server and answered 1 of 13, and the third also grepped and answered 13 of 13.

got and axios are the other side of the same rule. got's `tsconfig.json` includes `source`, `test`
and `benchmark`, so tsserver sees the test callers. axios sets no `include` at all, so the whole tree
is in the program. Both come back near-perfect — and axios is the one repository here where p-graph
loses badly.

| Question | grep | p-graph | tsserver |
|---|---|---|---|
| `nest-serialize` | 39/39 | 39/39 | **15/39** |
| `nest-pipescontextcreator-create` | 12/12 | 12/12 | **6/12** |
| `nest-serializer-serialize` | 60/60 | 60/60 | 60/60 |
| `nest-extendarraymetadata` | 36/36 | 36/36 | 30/36 |
| `nest-validateeach` | 30/30 | 30/30 | 26/30 |
| `got-beforeerror` | 75/75 | 75/75 | 71/75 |
| `got-options-merge` | 54/54 | 54/54 | 54/54 |
| `axios-headers-has` | 78/78 | 74/78 | 76/78 |
| `axios-eject` | 75/75 | **51/75** | 75/75 |

Three runs a side, so each cell is three times the question's own site count.

### Python: the answer depends on which files are open

Twelve questions on requests, flask, httpx and django — eight list questions plus three
"what breaks" and one "show the chain" — three runs a side, `pyright-langserver`.

| 8 list questions | grep | p-graph | pyright |
|---|---|---|---|
| Call sites found | **243 of 243** | **243 of 243** | 233 of 243 |
| Call sites invented | 0 | 14 | **0** |
| Cost per question | **$0.148** | $0.149 | $0.233 |
| Time per question | 28 s | **22 s** | 49 s |
| Steps per question | **4.0** | 4.1 | 10.6 |
| `LSP` calls and greps per question | — | — | 2.6 and 2.9 |

This is the arm's best language for cost per call. On Go a list of N call sites cost about N `LSP`
calls; on Python one `findReferences` returns the list, and three django runs came in at $0.04 to
$0.08 in two turns — one call, one complete answer. p-graph's 14 invented rows are the
`RequestsCookieJar.update` guesses already described above, not a new defect.

The ten missing sites are all the same shape, and it is not a config boundary this time. Every one is
a single run of three:

| Question | run 1 | run 2 | run 3 |
|---|---|---|---|
| `httpx-cookies-set` | 10 of 10 | 10 of 10 | **3 of 10** |
| `httpx-raise-for-status` | 12 of 12 | 12 of 12 | 10 of 12 |
| `django-escape-leading-slashes` | 2 of 3 | 3 of 3 | 3 of 3 |

**pyright's `findReferences` answers from the files that are open.** Three requests to the same
server, same repository, same symbol — `Cookies.set`, whose 10 call sites are 3 in `httpx/_models.py`
and 7 in `tests/models/test_cookies.py`:

```
--refs httpx/_models.py:1117:8                     → 3 references, all in _models.py
--refs tests/models/test_cookies.py:26:17          → 6 references, all in the test file
--also-open tests/models/test_cookies.py \
  --refs httpx/_models.py:1117:8                   → 10 references — exactly the truth
```

An editor keeps many files open, so a person rarely meets this. An agent sees exactly as much as it
happened to read first: the run that answered 3 of 10 asked once, at the definition, and stopped. The
two runs that answered 10 of 10 had read more of the repository before asking.

That is the same user-visible failure as the TypeScript one, from a different cause. There the
program was bounded by `tsconfig.json`; here the reference search is bounded by what is open. Both
return a short list in the same voice as a complete one.

### C++: the compile database is a ceiling, and a virtual method splits its callers

Fifteen questions on leveldb, re2, spdlog and rocksdb — twelve list questions plus two "what breaks"
and one "show the chain" — three runs a side, `clangd`.

| 12 list questions | grep | p-graph | clangd |
|---|---|---|---|
| Call sites found | 590 of 594 | **591 of 594** | 517 of 594 |
| Call sites invented | 0 | 0 | 0 |
| Cost per question | $0.257 | **$0.261** | $0.288 |
| Time per question | 45 s | **40 s** | 57 s |
| Steps per question | 8.3 | **7.0** | 13.5 |
| `LSP` calls and greps per question | — | — | 3.0 and 2.3 |

This is the language the server was expected to win, and it is its worst. Two mechanisms account for
the 77 missing sites, and both were reproduced from the server directly.

**A file that is in no build target does not exist.** clangd answers from `compile_commands.json`, so
a source file no target compiles is invisible whatever the flags are. Counted before the run, 200 of
the 211 truth sites sit inside a compile database — and the misses are the same in all three runs,
which is what a structural limit looks like next to run-to-run noise:

| Missing | Why | Sites |
|---|---|---|
| `db/fault_injection_test.cc`, `issues/issue178_test.cc`, `issues/issue320_test.cc` | commented out in leveldb's own `CMakeLists.txt` | 5 |
| `app/_re2.cc` | a Python extension, not a CMake target | 1 |
| `java/rocksjni/write_batch_test.cc` | JNI, and `WITH_JNI` needs a JDK | 1 |

**A virtual method splits its callers between the declaration and each override.** This is the big
one — 52 of the 77, from one question. `spdlog::sinks::sink::log` is pure virtual and has 29 call
sites. Ask clangd at the declaration and at the override:

```
--refs include/spdlog/sinks/sink.h:15:17        →  3 references
--refs include/spdlog/sinks/base_sink.h:31:9    → 30 references, all in tests/
```

Neither answer is the answer to "who calls this method". A call written on a `base_sink` is a
reference to the override, not to the declaration the question names. One run of three asked about
the overrides too and scored 29 of 29; the other two answered the 3 and stopped. p-graph, which
matches on the name, returned 87 of 87 — the same name matching that produces its guesses elsewhere,
paying off here.

### The C++ setup was the hard part, and the 8.3 path struck a third time

Nothing about this arm was as expensive as making clangd answer at all. Written down because every
step of it was a wrong number first:

- **A short Windows path in the compile database stops the index before it starts.** `cmake` was run
  through `%TEMP%`, which on this machine is `C:\Users\ANDREY~1.SUK\…`, so every `file` and
  `directory` in `compile_commands.json` was in 8.3 form. clangd loaded the database, parsed a single
  file correctly, and **enqueued nothing**: twenty minutes of waiting, zero index shards, not one log
  line about indexing. Re-running `cmake` from the canonical long path gave 230 shards and a working
  index. This is the third time the 8.3 path has broken this study — it killed 17 of 18 runs in the
  first gopls pass, and neither grep nor p-graph has ever noticed, because neither cares how a path
  is spelled.
- **A settled index is not the first plateau.** leveldb's shard count sat at 128 long enough to look
  finished, then climbed to 151, then to 230. clangd's answer for `Status::ToString` grew with it:

  | Index shards | clangd's answer | A text search finds |
  |---|---|---|
  | 0 (short paths) | the index never starts | 42 |
  | 128 | 6 | 42 |
  | 151 | 20 | 42 |
  | 230 (settled) | **45** | 42 |

  At no point did clangd say its index was incomplete. The probe now waits for five unchanged polls
  of the shard directory before it believes any count.
- **What it took, and what it did not.** No admin rights: Visual Studio 18 Insiders already had MSVC,
  CMake and Ninja, and `clangd` is a zip unpacked into a user folder. What cost real time was the
  dependencies — abseil and googletest built from source for re2, Catch2 fetched by spdlog — and
  rocksdb's own rule that **tests are excluded from Release builds**, which quietly left 411 entries
  in its database where a Debug configure gives 1005.
- One number to read with care: clangd's `--limit-references` defaults to 1000, and a warm-up probe
  came back with exactly 999. No question here comes near it, but a bigger one would.

### Two truth lists were short, and the arms are what showed it

The lsp arm's first score on the follow-the-calls questions read **24 invented sites**. None of them
was invented. Both fixes are in `measure-agent.mjs`, and both move a published number:

- **`requests-gethost-impact`** — `MockRequest.get_host` is called back by the standard library's
  `CookieJar` through duck typing. The lsp answers named the whole real chain —
  `jar.extract_cookies` and `jar.add_cookie_header`, then the seven functions that call those — and
  said in the same breath that they are not call sites and would only need updating if the method's
  name or signature changed. That is right. They are real code outside the question's bound, so they
  now count for neither side. grep's own 6 "invented" on this question were the `@property` line
  directly above a truth definition — an off-by-one against a decorator.
- **`django-trace-processrequest-escapeslashes`** — `process_response` reaches
  `escape_leading_slashes` through the same hop as `process_request`, from a different entry point.
  `common.py:109` was named by all three grep runs and two of three lsp runs. Five answers of nine
  against the list is the tell this study has already learned to read: doubt the list.

After both fixes the follow-the-calls invented counts are **grep 0, p-graph 0, lsp 3** — where they
had read 9, 0 and 24. The three that remain are one each on three questions, and one of them is a
genuine error: an lsp run put `should_redirect_with_slash` on the chain, and it does not reach the
target.

> **Withdrawn.** This paragraph used to open "for Go, reach for the language server first — it
> answered every call site of every question." That was true when it was written and it is not the
> advice any more: p-graph now reads 277 of 279 on the same Go questions, level with grep and 2 short
> of the server, at a third less cost. See "Why Go moved".

**The advice this arm supports, now that all four languages have run and the Go fix has landed:** the
server wins no language outright. Over the 33 list questions all three arms share, p-graph is now
ahead of the server study-wide — 1,542 call sites of 1,575 against 1,442 — because what it loses to
gopls on Go (277 against 279, 2 sites) it more than makes back on Python, C++ and TypeScript, where
the server is bounded in ways a graph is not. TypeScript is bounded by what `tsconfig.json` covers: a
monorepo split into per-package projects, or a project that excludes its tests, is short and does not
say so. Python is bounded by which files are open, so ask again after reading more; per call it is
the cheapest of the three. C++ is bounded twice over — by the compile database, and by the fact that
a virtual method's callers are split between the declaration and each override, so "who calls this"
needs one question per override. Weighing recall, invented rows, cost and steps together, per
language: **Go and C++ favour p-graph, Python and TypeScript favour grep** — the server is not the
first reach for any of them, even on Go.

Reach for p-graph for "what breaks if I change X" on a big repository, for any repository that does
not build, for any question whose callers live outside the type program, and for a virtual or
duck-typed call, where matching on the name beats resolving the type.

### The first pass of this arm was thrown away, and the reason matters

17 of the first 18 runs never reached `gopls` at all. Every one of them got `no active builds` for
every file, fell back to grep, and produced numbers that looked like a verdict on language servers:
$0.703 a question against p-graph's $0.316.

The cause was the workspace path. `os.tmpdir()` on that machine returns the Windows 8.3 short form,
`C:\Users\ANDREY~1.SUK\…`, and gopls refuses such a root outright — *component "ANDREY~1.SUK" is
listed by Windows as "Andrey.Sukharev"*. Every `claude -p` was launched with that cwd, so the server
loaded nothing.

**grep and p-graph had run 312 times from the same wrong path and neither noticed**, because neither
validates its workspace root. Resolving the path with `realpathSync.native` fixed it, and the same
questions came back at $0.357 — most of the "language servers are expensive" gap had been the cost of
failed attempts.

Two lessons are now built into the runner:

1. **`lspPreflight` proves the server answers** before the first dollar is spent — it warms the
   workspace and then requires a real symbol list back, per repository. Checking that the binary is on
   `PATH` was never enough.
2. **The rule makes the agent say where its answer came from.** That single sentence — "this comes from
   a text search, not the LSP" — is the only reason the dead arm was caught instead of published.

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

- **We published an accuracy claim built on a truth list that was short by a third.** The headline said
  p-graph invents a third as many call sites as grep. `caddy-handler-servehttp` has 51 call sites and
  its list held 34, so the 17 real rows grep found every run were scored as inventions — and p-graph,
  which finds the same 34 the list stopped at, was scored as perfect. Corrected: grep invents 0 across
  36 questions, p-graph 14, and grep leads recall by 72 sites. **The claim this page led with for four
  passes was an artifact of its own ground truth.** It took a third arm naming the same lines to see it.
- **The whole first pass of the language-server arm measured nothing, and it looked like a result.**
  `os.tmpdir()` returned the Windows 8.3 short path, gopls refuses such a workspace root, and 17 of 18
  runs silently fell back to grep — reporting $0.703 a question against p-graph's $0.316. Fixed, the
  same questions cost $0.357. The preflight had checked that `gopls` was on `PATH`, which proves
  nothing; it now warms the workspace and requires a real answer back. **grep and p-graph had run 312
  times from that same wrong path without complaint**, because neither validates its workspace root.
- **A regex that looked for the failure nearly stopped a healthy run.** The fallback detector matched
  `text search` in the sentence *"found via LSP findReferences … not a text search"* — an answer
  asserting the opposite of what it was flagged for. Negated forms are now stripped before the test,
  and no run is stopped on a regex hit alone: the answer gets read first. The detector proposes,
  reading decides.
- **The oldest rows in `runs.jsonl` have `lang: null`, and filtering on it silently halves a table.**
  The first pass was written before that field existed. An analysis script that grouped by the row's
  own `lang` dropped 9 of 12 big-Go grep rows and would have published grep at 152 of 153 instead of
  277 of 279. The script's own tables never had the bug because they group by the question, not the
  row. Anything reading `scored.json` directly has to do the same.
- **The probe written to catch a broken setup was itself flaky.** `gopls symbols` failed on caddy
  immediately after the warm-up call, then succeeded by hand moments later — a second gopls starting
  behind the first one's cache write. A probe that blocks a good setup is as bad as no probe, so it
  retries once, which is the same thing the rule tells the agent to do.
- **A fix that only added coverage made the answer more expensive, and we shipped nothing until the
  second measurement.** Indexing Go interface methods took `callers "caddyhttp.Handler.ServeHTTP"` from
  "no symbol named" to 23 of 34 call sites — and the A/B came out WORSE: $1.07 grep against $1.68
  p-graph. The 18 rows the graph could not place were an ⚠ banner, and a banner that long sends the
  agent to grep, so the run paid for both. Two more fixes took it to 27 sites and 14 rows and the cost
  to $0.83. Third round in a row where the deciding factor was the size of the banner, not the size of
  the answer.
- **We fixed the graph, re-measured, and Go recall did not move — because the wording, not the code,
  was still the problem.** Indexing implementer calls through an interface method took
  `caddy-handler-servehttp` from 1 of 18 call sites resolved to 18 of 18, but the first re-measurement
  after the fix landed came back unchanged: the agent printed all 18 lines with citations, then filed
  them under a heading it invented on the spot — "a concrete implementer of `Handler`, not the
  interface value itself" — because the rule's table of headings had a row for the old wording and
  none for the new one. The extractor read that heading as a hedge and scored 1 of 18. Adding the
  missing row and rewording the heading, with no change to the graph, took the question from 104 to
  152 of 153. **That is the fourth time this study has found wording moving the number more than code
  did** — after the ⚠ banner size on `caddyhttp.Handler.ServeHTTP` two rounds earlier, on
  `re2::Prog::size`, and on `AxiosHeaders.has`. Reading the answer the agent actually produced, not
  just the graph data behind it, is now part of shipping any fix to a heading.
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

- **Forty-two questions, three runs, one model.** Still small. Three questions per language is enough
  to notice a shape and not enough to size it, and every language carries more only because the first
  three in each turned out to miss the shape that was broken. A stronger model would likely make grep
  better still, which moves the "who calls X" result further against p-graph, not for it.
- **Two questions carry a lot of the headline.** `re2::Prog::size` costs grep $1.11 and
  `Handler.ServeHTTP` $1.07; the next dearest costs $0.35. Together they are a third of the study's
  whole grep bill. Read the per-language boxes, not just the average.
- **Thirty of the forty-two questions are one shape**: "list every call site". That is the shape
  grep is best at. The other twelve follow the calls instead, and eleven of those are scored — see
  "Following the calls". Building their ground truth by hand is slow and it is the reason there were
  none for so long.
- **p-graph gets a `CLAUDE.md` that the grep side does not.** That is deliberate — it is what
  `/p-graph:init` installs, so it is part of the thing being measured — but part of the extra cost is
  that file telling the agent to double-check with grep.
- **All twelve repos are open source and well known.** The model may have seen them. That helps both
  sides, and it may flatter grep more, since p-graph reads its answer off the index.
- **The global `~/.claude/CLAUDE.md` was loaded in both arms.** Identical on both sides, but it is not
  a clean room.
- **`/p-graph:query` ran 3 times in 93 this pass, 2 in 27 the pass before, 0 in the first.** So this
  page mostly measures p-graph read as a command-line tool, not the plugin's own skill. One confound
  did partly untangle itself: two passes ago all three transitive runs used the skill and we could not
  tell the skill from `impact`. Since then only one of the three did, and the transitive question still
  came in half under grep — so the win is not the skill alone. p-wiki's study has the same hole from
  the other side: `/p-wiki:query` ran once in 77.
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
- **`callers` on a Go interface method reports the calls that run through an implementation of it**,
  and a Go interface keeps every method it declares, not just its first. TypeScript's indexed
  interface-method count got the same fix. See "Why Go moved".
- **The implementation-reach heading was reworded** so it reads as part of the answer, not an aside —
  and the installed rule gained the row that names it, so an agent has somewhere to look up what the
  heading means. See "Why Go moved" and "What we got wrong".

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
