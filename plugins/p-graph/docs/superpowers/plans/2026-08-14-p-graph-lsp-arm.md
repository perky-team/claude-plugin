# A third arm: p-graph against a language server

August 2026. The study in `docs/measured-benefit.md` compares p-graph against an agent with
`grep` and `Read`. It does not compare p-graph against a language server, and it never could:
the runner switches the user's Go LSP off in **both** arms, on purpose, because leaving it on
would have let `gopls` answer the Go questions in the grep arm and void the whole comparison.

That was the right call for the question the page asks. It also means the page cannot answer the
question a user actually asks next: **grep is the floor — what about the strong alternative?**

This plan adds that third arm.

## Why the answer is not obvious either way

The two tools are not the same kind of thing, and each has something the other cannot get.

```
                      language server              p-graph
what it reads         the compiler's own view      the types the source writes
                      of the code                  down, read with tree-sitter
needs the project     YES — resolved modules,      NO — it parses text
  to build              npm install, a C++
                        compile_commands.json
name to answer        needs file+line+character    takes a name
transitive walk       one request per hop          one `impact` call
says what it missed   no                           yes — the gap banner
languages here        one server per language      four languages, one index
```

The p-graph page already names the limits on its own side: a receiver typed by a method call on a
value that is not typed yet, a method promoted through embedding (dropped,
51 edges), two packages sharing a name (188 hugo calls refused). A language server has none of
those limits. So on accuracy the honest expectation is that the server wins.

One entry in that list was later found to be misattributed. `caddyhttp.Handler.ServeHTTP` was not a
receiver-typing miss: the graph reads `ih := newMetricsInstrumentedRoute(…)` correctly and resolves
all 18 calls in `metrics_test.go` certainly, to `metricsInstrumentedRoute.ServeHTTP`. What was missing
was the question's shape — asked about the interface method, the graph had no way to report the calls
that run an implementation. See `2026-08-24-go-interface-method-set.md`.

The interesting columns are the other ones: cost, time, steps, and what the setup costs.

## What was built

Three changes, all in `scripts/`:

| What | Where |
|---|---|
| the `lsp` arm — prep, preflight, run, report | `scripts/measure-agent.mjs` |
| the rule the arm installs as `CLAUDE.md` | `scripts/lsp-arm-rule.md` |
| the four servers, as a generated plugin | written to `<work>/.lsp-arm-plugin` at run time |
| a small LSP client, for probing a server by hand | `scripts/lsp-probe.mjs` (added for stage 2) |

`--phase preflight` runs the readiness check on its own and spends nothing. Use it while installing.

The servers are copied from the official marketplace entries — `gopls-lsp`, `clangd-lsp`,
`pyright-lsp`, `typescript-lsp` — so the arm measures what a user who installs those plugins
gets, not a setup tuned by us. The arm reaches them through `--plugin-dir`, which is exactly how
the graph arm reaches p-graph. One flag, one difference.

Run it the same way as the other two:

```bash
node plugins/p-graph/scripts/measure-agent.mjs --phase lsp
node plugins/p-graph/scripts/measure-agent.mjs --score
```

`--score` prints one new section, `== the lsp arm, against both ==`, and only when there are
`lsp` rows. Every table above it is untouched, so no published number can move because this arm
was added.

**That section counts only questions all three arms have answered**, and says how many it
dropped. Averaging the new column over a smaller question set and printing the three side by
side is the mistake this study has already made twice.

## The preflight refuses to start on a broken setup

A misconfigured server is the worst thing that can happen to this arm. It answers nothing, the
agent falls back to grep, and the row reads "the language server lost" when what lost was the
install. So `lspPreflight` checks, before the first dollar is spent, that every server the chosen
questions need is on PATH, and that each C++ repo has a `compile_commands.json`. It throws and
names what is missing.

Measured, not assumed — this is what it says on this machine today:

```
the lsp arm is not ready:
  - C++: `clangd` is not on PATH
  - TypeScript: `typescript-language-server` is not on PATH
  - leveldb: no compile_commands.json — clangd cannot type-check it
```

## Does the LSP tool even work in a headless run?

It does. This was the one blocking unknown, so it was tested before anything was written: one
question on the gin clone, `Grep`, `Glob` and `Bash` all disallowed, so the only way to an answer
was the `LSP` tool.

| | result |
|---|---|
| answer | all **14 of 14** call sites of `bytesconv.StringToBytes`, 0 invented |
| ground truth | the same 14 — the arm's own hand-built list |
| cost | $0.41, 10 steps, 58 s of API time |
| for comparison, from the study | grep $0.10 / 16 s (93% recall), p-graph $0.08 / 13 s (100%) |

Read the accuracy and ignore the cost. The cost is not the arm's number: the prompt forced
"use ONLY the LSP tool", grep was taken away, and there was no rule teaching the cheap path — so
the agent walked the API position by position and confirmed every reference. The real arm gets
grep, the same tools as the other two, and the rule below.

## The rule is the fragile part

This study has learned three times that the wording of the rule moves the number more than the
code does. `callers` printing the call site was worth more than every completeness fix. Rewriting
one paragraph took `/p-graph:query` from 0 runs to 4. A right answer with a long ⚠ banner costs
what having no graph costs.

So a thin LSP rule would lose for a reason that has nothing to do with language servers.
`scripts/lsp-arm-rule.md` is written to the same standard as the p-graph rule: a table from a
name to a position, an operation per question shape, the difference between `findReferences` and
`incomingCalls`, do not grep to double-check, and — the one thing a server will not say for
itself — name the limit when the symbol is the kind of thing a framework dispatches to by
string.

**It is still the weakest part of this design.** Anyone reading the result should read that file
first and ask whether a better rule would have changed the answer.

## What is ready, and what the setup costs

The clones from the existing study are all still in the work dir at their pinned commits, so
nothing needs re-cloning. What each language needs on top:

| Language | Server | State on this machine | To make it ready |
|---|---|---|---|
| Go | `gopls` | **installed**; gin's deps are cached | `go mod download` in caddy and hugo |
| TypeScript | `typescript-language-server` | **installed**, and nest, got, axios have their `node_modules` | done |
| Python | `pyright-langserver` | **installed** | `lsp-probe.mjs` needs Python's import shape added |
| C++ | `clangd` | missing, **and no toolchain at all** | install clangd + cmake + a compiler, then configure each repo to emit `compile_commands.json` |

C++ is the expensive one, and that is a finding rather than an inconvenience: `cmake`, `ninja`,
`g++`, `clang++` and `cl` are all absent here. To ask clangd "who calls this" on rocksdb you must
first be able to build rocksdb. p-graph answered the same question with no toolchain at all.

Python has a smaller version of the same issue. The clones have no virtualenv, so pyright will
not resolve third-party imports. Every Python question in the set is about a symbol inside the
repo, so this should not bite — but it is untested, and it is the kind of quiet degradation that
would show up as "the server lost".

## Recommended run order

Stage it, and read each stage before paying for the next.

| Stage | What | Questions | Setup | Rough cost | State |
|---|---|---|---|---|---|
| 1 | Go | 16 | `go mod download` ×2 | ~$4 | **done** — 6 questions, $7.12 |
| 2 | TypeScript | 9 | three npm installs | ~$2 | **done** — 9 questions, $6.99 |
| 3 | Python | 12 | one npm install | ~$2 | **done** — 12 questions, $8.46 |
| 4 | C++ | 15 | a whole C++ toolchain | ~$4 | **done** — 15 questions, $13.76 |

The "rough cost" column was too low by a factor of three. An lsp run costs about $0.26 to $0.40, so
nine questions three times over is $7, not $2. Read the State column, not the estimate.

Stage 2 needed three things the plan did not list:

- **`npm ci` fails on nest** with an ERESOLVE peer-dependency error. `--legacy-peer-deps` fixes it.
  Watch the exit code: piping npm through `tail` hides the failure and reports success.
- **axios is JavaScript.** Its only `.ts` files are under `tests/`, so a `.ts`-only probe finds
  nothing to look at. `LSP_WARM.TypeScript` tries `.ts` and then `.js`.
- **A probe must ask more than once.** On nest the first `definition` request returns nothing and the
  second returns the declaration, because tsserver is still building its program. This is the same
  failure that threw away the first Go pass, in a different server.

Stage 3 needed one more thing, and it is the same lesson again:

- **django writes no relative imports at all.** The probe preferred a relative import and fell back
  to the file's first import, which in django is `from collections import Counter`. It passed django
  on a jump into a typeshed stub — proof that pyright found its own bundled stubs, and nothing about
  the repository. The probe now works out which top-level packages the repository owns (a directory
  with `__init__.py`, or with a `package.json`) and, when the import is one of those, requires the
  jump to land inside the repository.

Stage 3 also produced the arm's sharpest single finding, and it needed a flag to prove:
`--also-open`. pyright's `findReferences` answers from the files that are open, so the same symbol
gives three different answers depending on where you ask from. See the write-up.

Stage 4 needed no admin rights and no MSVC install — Visual Studio 18 Insiders already had MSVC,
CMake and Ninja, and `clangd` is a zip unpacked into `%LOCALAPPDATA%`. What it did need:

- **abseil and googletest built from source** for re2, and a Debug configure for rocksdb, because
  rocksdb excludes tests from Release builds (411 database entries against 1005).
- **The canonical long Windows path.** `cmake` run through `%TEMP%` writes 8.3 paths into
  `compile_commands.json`, and clangd then enqueues nothing at all to index. Third time this study
  has been broken by the 8.3 path.
- **A settle loop for the index.** clangd's shard count plateaus before it is finished, and its
  answer grows with the shard count. See the write-up's table.
- **A cross-file check that excludes the file the probe opened.** clangd answers from the open file's
  AST as well as the index, so the first version passed leveldb with an empty index.

`--phase preflight` is now also the warm-up: it waits for each C++ repository's index to settle
before the first paid run.

Stage 1 alone answers the question that was actually asked, because Go is where the official LSP
plugin is already installed and where the user works. If stage 1 says the server wins on Go by a
wide margin, stages 2–4 tell you how far that generalises. If it says the two are level, the
setup cost decides it and C++ may not be worth configuring at all.

Add `--only <id>,<id>` to run part of a stage. Runs are appended to `runs.jsonl` and never
repeated, so a stage can be stopped and restarted.

## Threats to validity

- **The rule.** Named above. The biggest one.
- **Three runs a side.** The study's own note stands: three runs cannot read the accuracy rows
  closely. Re-running one arm moved two languages the change could not touch. A new arm with the
  same three runs inherits that.
- **The noise floor is paired between two arms.** `noise()` compares base against graph. It is
  not extended to three, so any lsp gap must be read against the existing floor — cost moved 18%
  between two identical passes of the untouched baseline — and not treated as tighter than that.
- **The server gets a warm index, or it does not.** gopls and clangd index in the background. The
  first question against a repo pays for that and later ones do not. Three runs per question, run
  back to back, means run 1 may be dear and runs 2–3 cheap. Worth reading the per-run numbers in
  `scored.json`, not only the averages.
- **This machine is Windows.** The existing base and graph rows were measured here, so the lsp
  arm must run here too for the columns to be comparable. clangd and gopls on Windows are not the
  same performance as on Linux, and the write-up should say so.

## What is deliberately not built

- No three-arm noise floor. Extending `noise()` would touch the function that prints the
  published headline table, and the cost of a mistake there is a wrong published number.
- No LSP-vs-p-graph combined arm. "Both installed" is a real setup a user might have, but it
  answers a different question and doubles the runs.
