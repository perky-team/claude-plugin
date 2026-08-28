# perky.team plugins

A Claude Code plugin marketplace. Plugins live under `plugins/<name>/`.

## Install the marketplace

Open Claude Code CLI and add this repository as a marketplace, then install any plugin from it:

```text
/plugin marketplace add perky-team/claude-plugin
/plugin install <plugin-name>@perky.team
```

`<plugin-name>` is one of `p-wiki`, `p-flow`, `p-tasks`, `p-statusline`, `p-graph`, `p-shed`, `p-chat` (see below).

`/plugin install` asks for an install scope: **user** (you, in every project — the usual pick), **project** (everyone on this repo; the entry goes into `.claude/settings.json`), or **local** (you, this repo only). From a shell, `claude plugin install <plugin-name>@perky.team --scope user` skips the prompt. Run `/reload-plugins` afterwards to pick the plugin up in the current session.

Each plugin then needs a one-time setup inside the repo you work in — `/p-wiki:init`, `/p-graph:init`, `/p-tasks:init`, `/p-flow:init`, and so on. That step writes the plugin's files into the project and the rule that tells Claude the plugin is available here.

From a non-GitHub git host:

```text
/plugin marketplace add https://gitlab.com/perky-team/claude-plugin.git
/plugin install p-wiki@perky.team
```

Update an installed plugin after the marketplace receives changes:

```text
/plugin marketplace update perky.team
/plugin update <plugin-name>@perky.team
```

Uninstall:

```text
/plugin uninstall <plugin-name>@perky.team
```

## Plugins

### [`p-wiki`](./plugins/p-wiki/)

Persistent markdown knowledge wiki under `docs/wiki/` of the project repo, with a bundled `pwiki` CLI. Captures external sources (URLs, files, pastes) into `raw/`, then synthesizes them into linked concept pages on demand. Answers questions with citations from accumulated project knowledge.

Pages live on the filesystem or in Confluence Cloud: one primary destination plus any number of mirrors that `pwiki sync` overwrites one-way. A wiki can also read other wikis as **read-only sources** — an on-disk clone, a foreign Confluence space, or a published `index.json` bundle over GitHub / GitLab / HTTP. Search covers the primary first, then each source in declaration order, and cuts the merged list to the limit. `/p-wiki:init` offers to connect sources, and re-running it on an existing wiki skips the scaffold and goes straight to that offer; `pwiki source add` is the CLI behind it.

Skills: `init`, `ingest`, `compile`, `query`, `lint`, `reconcile`, `sync`.

Measured, not assumed: [`docs/measured-benefit.md`](./plugins/p-wiki/docs/measured-benefit.md) reports a controlled A/B of where this plugin pays off — knowledge that is not in the repo, where it is the difference between 100% of the facts and 14% — and where it does not, including one cost claim the study had to withdraw.

### [`p-flow`](./plugins/p-flow/)

A development process, not a set of tips: one feature or one bug is one branch, one spec folder, one plan, one MR. The unit of work is picked first (`feature` / `bugfix` / `hotfix` / `chore` / `docs`), then it walks brainstorm → spec → plan → implement → verify → review → push with a ready-to-copy MR command. Ships the repo-level rules too: secrets deny-list, Conventional Commits + `<type>/<slug>` branch naming, and spec templates (ADR, Gherkin, full specification).

By default each plan step runs in a fresh implementer subagent with a per-step review, so the main context stays clean; implementing inline in the current session is the opt-in alternative. Reviews are read-only and dispatched as `Task` + `general-purpose` with inline templates colocated with the requesting skill — there is no `agents/` directory. The one exception is the spec auditor, which fixes the spec itself. A `SessionStart` hook surfaces the flow on every fresh session, after `/clear`, and after auto-compaction, so Claude finds it without keyword guessing.

Optional one-way bridges, active only when the other plugin is initialised in the same repo: the plan lives in `p-tasks` (and then no `plan.md` is written at all), task decisions compile into `p-wiki`, and `p-graph` informs step granularity with the change's impact set. None of them is required — p-flow installs and runs standalone.

Commands: `init`, `task-start`, `task-end`.
Skills: `using-p-flow`, `init`, `task-start`, `task-end`, `task-brainstorming`, `writing-plan`, `subagent-driven-development`, `executing-plan`, `test-driven-development`, `verification-before-completion`, `systematic-debugging`, `requesting-code-review`, `requesting-task-review`, `receiving-code-review`, `using-git-worktrees`, `writing-skills`.

Requires Sonnet or stronger for the review dispatches — weaker models ignore the reviewers' scope rules.

### [`p-tasks`](./plugins/p-tasks/)

Two-level task tracker (`task` → `sub-task`) with FS and Jira destinations. One-way `primary → mirrors` sync.

Items carry `todo` / `in_progress` / `done` and blocker links; a sub-task can also hold an acceptance criterion, expected files, its kind, where it came from, and the reason a review finding was rejected. The CLI validates every write: an unknown status, a blocker that does not exist, or a blocker cycle is refused, and `next` never offers a step whose blockers are still open — that is what a plain TODO file cannot do.

Skills: `init`, `add`, `set`, `next`, `list`, `summary`, `sync`.

### [`p-statusline`](./plugins/p-statusline/)

A custom Claude Code status line — the three-line bar at the bottom of the terminal. Activated via the `install` skill, which copies the renderer script to `~/.claude/p-statusline/` and wires `statusLine` in `~/.claude/settings.json` with `"refreshInterval": 10`, so the countdowns and the RAM figure keep ticking while the session is idle instead of freezing at the last reply.

The status line shows:

**Line 1 — `context | rate limits | git`**
- **Context window** — usage `%`, consumed tokens (e.g. `64k`), and cache-hit `%`. The percentage and token count share a green → red ramp that warms as the window fills. Shows a dim `-%` placeholder before the first API response, and `c-` for the cache figure right after `/compact`, until the next response.
- **Rate limits** — `5h` and `7d` usage windows side-by-side, each as `XXX%[countdown]` with reset countdown (e.g. `5h  25%[3h12m]`). Fixed 30-character width: percentages right-aligned, countdowns padded so the `%`, `[`, `]` landmarks line up. The two countdown columns differ — 5 wide for `5h`, 6 for `7d` — because that is the widest value each window can reach (`4h59m` against `10h41m` in the 7-day window's last day); a 6-wide column in the 5-hour window could never fill. `n/a` (padded) until Claude Code reports data.
- **Git** — branch name (magenta), `*` for uncommitted changes, a `wt:` marker inside a linked worktree (yellow `wt`, gray `:`), and `↑N↓M` commits ahead-of / behind upstream.

**Line 2 — `model | path | RAM`**
- **Model + effort** — bare model display name with effort level (`Opus 4.7 xhigh`).
- **Project path** — the project's launch directory. Capped at the limits-section width: if longer, truncated from the start with a `...` prefix so the folder name (end of the path) stays visible, and the second `|` separator vertically aligns with line 1.
- **RAM** — system memory usage with the same green → red ramp as the rate-limit %.

**Line 3 — session name**
- The name set with `--name` or `/rename`, or else the title Claude Code writes from the first prompt. Shows `-` until that title exists and again right after `/clear`, so the bar keeps three rows instead of flipping between two and three. Cut to the terminal width from `COLUMNS`.

The leading segments of lines 1 and 2 (context / model+effort) are padded so the first `|` separator vertically aligns.

Everything on the bar comes from the JSON Claude Code pipes in on stdin — including the cache-hit figure and the worktree marker, which earlier versions dug out of the transcript file and a `git rev-parse` call. A render now costs four short git calls and no file reads.

Skills: `install`, `help`.

### [`p-graph`](./plugins/p-graph/)

A local code knowledge graph with a bundled `pgraph` CLI. Indexes the project (TypeScript/JavaScript, Go, C++, Python) into a SQLite graph of symbols and their call/import/extend edges, so Claude answers structural questions — where a symbol is defined, what calls it, what breaks if it changes, how one symbol reaches another — from the index instead of grepping. Fully local, no MCP server.

Why it matters: `impact` returns the whole transitive set in one small answer, including callers that never mention the symbol's name and so are invisible to grep. Ambiguous names stay unresolved rather than linked to a guess, so the graph never invents an edge. Queries refresh the changed files first, so day-to-day freshness needs no manual sync.

**Measured against a grep-only agent: fourteen public repos, 52 structural questions, 312 runs, three
runs a side** — plus a third arm on 6 Go, 9 TypeScript, 12 Python and 15 C++ questions against a language server, below. Every table
here is printed by `measure-agent.mjs --score`, not worked out by hand, so any of it can be
regenerated.

Below are the 36 "who calls X" questions — the shape grep is best at — split by language and by how
big the repository is. The size line falls between leveldb (132 files, 9k call edges) and caddy
(326 files, 24k). **Read the accuracy rows here knowing that one truth list in this set was wrong
until August 2026** and its correction reversed the headline; the note under big-Go says which.

Big repositories:

**Go** — hugo 930 files / 55.5k call edges, caddy 326 / 23.6k · 5 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | **277 of 279** | **277 of 279** | **tie** |
| Invented | 0 | 0 | tie |
| Cost per question | $0.337 | **$0.240** | **−29%** |
| Time per question | 72 s | **45 s** | **−38%** |

This row used to read `226 of 228` both ways with grep inventing 51 — an artifact of one wrong
truth list. `caddy-handler-servehttp` really has **51** call sites, not 34, so grep never
invented anything there. Fixed, this row then read p-graph short by 48 of 279, because `callers`
on a Go interface method did not yet report the calls that reach it through an implementation.
That is fixed too — 28 August 2026, `callers caddyhttp.Handler.ServeHTTP` now names all 18 calls
in `metrics_test.go`, not 1 — and p-graph is back level with grep here. See
[the write-up](./plugins/p-graph/docs/measured-benefit.md#why-go-moved) for both fixes, code and wording.

**TypeScript** — nest 1,728 / 38.3k · 5 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 177 of 177 | 177 of 177 | tie |
| Invented | 0 | 0 | tie |
| Cost per question | **$0.142** | $0.144 | +1% |
| Time per question | **20 s** | 27 s | +35% |

**C++** — rocksdb 1,454 / 318.7k · 3 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 114 of 114 | 114 of 114 | tie |
| Invented | 0 | 0 | tie |
| Cost per question | $0.124 | **$0.080** | **−35%** |
| Time per question | 21 s | **14 s** | **−33%** |

**Python** — django 3,036 / 195.1k · 3 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 108 of 108 | 108 of 108 | tie |
| Invented | 0 | 0 | tie |
| Cost per question | $0.094 | **$0.083** | **−12%** |
| Time per question | 17 s | **13 s** | **−24%** |

Small repositories:

**Go** — gin 99 / 9.2k · 2 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 105 of 108 | **108 of 108** | **p-graph** |
| Invented | 0 | 0 | tie |
| Cost per question | $0.170 | **$0.130** | **−24%** |
| Time per question | 45 s | **24 s** | **−48%** |

**TypeScript** — axios 240 / 14.3k, got 85 / 14.3k · 4 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | **282 of 282** | 254 of 282 | **grep** |
| Invented | 0 | 0 | tie |
| Cost per question | $0.194 | **$0.155** | **−20%** |
| Time per question | 33 s | **26 s** | **−21%** |

**C++** — spdlog 152 / 8.2k, leveldb 132 / 9.2k, re2 89 / 8.3k · 9 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 476 of 480 | **477 of 480** | **p-graph** |
| Invented | 0 | 0 | tie |
| Cost per question | **$0.301** | $0.358 | +19% |
| Time per question | 52 s | **51 s** | **−2%** |

**Python** — flask 83 / 3.9k, httpx 60 / 4.2k, requests 37 / 2.7k · 5 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 135 of 135 | 135 of 135 | tie |
| Invented | **0** | 14 | **grep** |
| Cost per question | $0.181 | **$0.136** | **−25%** |
| Time per question | 34 s | **22 s** | **−35%** |

**Read these tables for accuracy, not for size.** Size decides nothing here: p-graph comes back
cheaper on seven of the eight boxes above, big and small alike, roughly flat on the eighth
(TypeScript's nest questions), and dearer on only one — small C++ (leveldb, re2, spdlog), where one
question, `re2::Prog::size`, now costs $1.85 against grep's $1.11.

**The accuracy claim this section used to make has been withdrawn.** It said p-graph invents far
fewer call sites, 51 against 14. Both numbers came from truth lists, and one of them was wrong:
after the fix, **grep invents 0 across all 36 questions and p-graph invents 14**, and grep is ahead
on recall by 33 call sites of 1,683 (1,674 against 1,650) — not the 72-site gap once published here.
Most of that gap closed on its own once `callers` on a Go interface method started reporting the
calls that reach it through an implementation; see "Why Go moved" in the write-up. On this question
shape — "list every call site" — grep is still the more accurate of the two, but only just.

What survives on this shape is not accuracy: **16% fewer steps** (5.7 against 6.8, 2.7 standard
errors) and answers that say what they might be missing, 70 of 156 against 4 of 156.

The size effect lives on the other question shape — "what breaks if I change X", "how does X reach Y".
There p-graph is **40% cheaper, 48% faster and 55% fewer steps** on the big repositories, and 22%
dearer on the small ones, measured on Go, C++ and Python alike.

**And that shape is where p-graph's accuracy advantage actually lives.** Over the 16 questions that
follow the calls, p-graph finds more and invents almost nothing:

| 16 questions that follow the calls | grep | p-graph |
|---|---|---|
| Call sites found | 180 of 216 | **187 of 216** |
| Invented | 32 | **1** |
| Steps per question | 9.4 | **7.6** |

On the big repositories the invented count is 26 against 0. That is the claim the list-shape tables
cannot support and this one can.

**A third arm: p-graph against a language server.** grep is the floor. The question a user asks next
is how the graph compares to the strong alternative, so the same questions were put to an agent with
the official language server plugins and the built-in `LSP` tool — 6 Go, 9 TypeScript, 12 Python and
15 C++ questions, 3 runs a side, same clones, same model.

| 4 list questions + 1 trap, caddy and hugo | grep | p-graph | gopls |
|---|---|---|---|
| Call sites found | 277 of 279 | **277 of 279** | **279 of 279** |
| Invented | 0 | 0 | 0 |
| Cost per question | $0.337 | **$0.240** | $0.357 |
| Time per question | 72 s | **45 s** | 78 s |
| Steps per question | 10.8 | **8.8** | 17.1 |
| `caddy-addnode-impact` — steps | 16.7 | 12.3 | 28.7 |

**This box used to read p-graph short by a third, and it no longer does.** `callers` on a Go
interface method now also reports the calls that run through an implementation of it — fixed
28 August 2026, see "Why Go moved" in [the write-up](./plugins/p-graph/docs/measured-benefit.md#why-go-moved).
p-graph is level with grep on call sites and still cheaper and faster than both. The language
server still finds 2 more of 279 and is still the most expensive in steps: it pays for its round
trips because the `LSP` API is addressed by file, line and character — a list of N call sites costs
N calls, where a graph query costs one.

Two things a language server cannot do, and they decide when the graph still wins: it needs the
project to **build** (resolved modules, `npm install`, a C++ `compile_commands.json`), and it walks a
call chain one request per hop — 28.7 steps against p-graph's 12.3 on the transitive question.

**On TypeScript the same arm came last, and that changes the advice.** Nine questions on nest, got
and axios, `typescript-language-server`:

| 9 list questions, nest · got · axios | grep | p-graph | tsserver |
|---|---|---|---|
| Call sites found | **459 of 459** | 431 of 459 | 413 of 459 |
| Invented | 0 | 0 | 0 |
| Cost per question | **$0.166** | $0.170 | $0.259 |
| Steps per question | 5.8 | **4.4** | 11.4 |

Forty of the 46 missing sites are in nest, and nest's own configuration explains both misses — each
reproduced from the server directly, with no agent in between. `PipesContextCreator.create` has four
callers and tsserver names two: nest ships nine per-package `tsconfig.json` files with
`"include": []`, so a sibling package's import of `@nestjs/core/pipes` resolves to the published copy
in `node_modules`, not to the source. `ClassSerializerInterceptor.serialize` has 13 callers and
tsserver names one: the root `tsconfig.json` excludes `**/*.spec.ts`, so the 12 test callers are
outside the program. Neither miss came with a warning.

**On Python the server is the cheapest of the three per call, and its answer is only as wide as the
files it has open.** Twelve questions on requests, flask, httpx and django:

| 8 list questions | grep | p-graph | pyright |
|---|---|---|---|
| Call sites found | **243 of 243** | **243 of 243** | 233 of 243 |
| Invented | 0 | 14 | **0** |
| Cost per question | **$0.148** | $0.149 | $0.233 |
| Steps per question | **4.0** | 4.1 | 10.6 |

One `findReferences` returns the whole list here, where Go cost about one call per site — three django
runs answered in two turns for $0.04 to $0.08. Every one of the ten missing sites is a single run of
three, and the cause was reproduced from the server: asked at the definition of httpx's `Cookies.set`
pyright names its 3 same-file callers, asked at a call in the test file it names the 6 others, and
with both files open it names all 10 — exactly the truth. An editor keeps many files open; an agent
sees as much as it read first.

**On C++ it is the worst of the three, and this was the language it was expected to win.** Fifteen
questions on leveldb, re2, spdlog and rocksdb:

| 12 list questions | grep | p-graph | clangd |
|---|---|---|---|
| Call sites found | 590 of 594 | **591 of 594** | 517 of 594 |
| Invented | 0 | 0 | 0 |
| Cost per question | $0.257 | **$0.261** | $0.288 |
| Steps per question | 8.3 | **7.0** | 13.5 |

Two mechanisms, both reproduced from the server. A file in no build target does not exist to clangd:
three leveldb test files are commented out in leveldb's own `CMakeLists.txt`, re2's `app/_re2.cc` is
a Python extension, and rocksdb's JNI test needs a JDK — 7 sites, the same in every run. And a
virtual method splits its callers: `spdlog::sinks::sink::log` has 29 call sites, where the base
declaration answers 3 references and the `base_sink` override answers 30. Neither is the answer to
"who calls this method". p-graph, matching on the name, returned 87 of 87.

Getting clangd to answer at all was the expensive part. A short Windows path in
`compile_commands.json` stopped its background index before it started — twenty minutes, zero shards,
no log line — and that is the third time the 8.3 path has broken this study. Even with long paths, the
first plateau is not the finish: at 128 index shards clangd named 6 callers of `Status::ToString`, at
151 it named 20, at 230 it named 45, and a text search finds 42. It never said the index was
incomplete.

**Withdrawn.** This used to say "for Go, reach for the language server first" — the server found
every call site where p-graph was short by a third. Fixed, p-graph is level with the server on Go at
a third less cost and half the steps, and over all four languages together p-graph now beats the
server on recall too: 1,542 call sites of 1,575 against the server's 1,442. The server wins no
language outright any more. Weighing recall, invented rows, cost and steps: **Go and C++ favour
p-graph, Python and TypeScript favour grep** — the server is not the first reach for any of them.
Know what bounds its answer regardless: TypeScript by what `tsconfig.json` covers, Python by which
files are open, C++ by the compile database and by one question per override for a virtual method.
Reach for p-graph for "what breaks if I change X" on a big repository, for any repository that does
not build, for any question whose callers live outside the type program, and for a virtual or
duck-typed call, where matching on the name beats resolving the type.

Read this arm with its limits in view: 42 questions, four languages, one machine, 3 runs a side.
Two of the study's own truth lists turned out to be short, found because this arm named real code they
were missing. And 17 of the first 18 runs had to be thrown away because `gopls` was silently
answering nothing at all.
All of it is written up in
[the plan](./plugins/p-graph/docs/superpowers/plans/2026-08-14-p-graph-lsp-arm.md).

**Three runs a side is not enough to read the accuracy rows closely.** Re-running only the p-graph arm
after a C++-only change moved two languages the change cannot touch: axios lost 24 of its 75 call
sites and requests invented 14 where it had invented none. The graph's own answers were checked and
were unchanged and correct, so that swing is the agent writing its answer up differently from one run
to the next. The published noise floor covers cost, time and steps — it has never covered found and
invented.

Every row of every language is in the plugin's own
[README](./plugins/p-graph/README.md#every-row-per-language); how it was measured, and every pass that
went the other way, is in [docs/measured-benefit.md](./plugins/p-graph/docs/measured-benefit.md).

Requires Node ≥ 22.5 (built-in `node:sqlite`).

Skills: `init`, `sync`, `query`, `help`.

### [`p-shed`](./plugins/p-shed/)

Scheduler/launcher for Claude Code headless runs. `p-shed` schedules jobs (cron timer + folder + prompt) and, on each due minute, launches `claude -p` in the job's folder. It is a pure scheduler: it does not store or resolve work items and installs no rules — what to do lives entirely in each job's prompt and in the target folder.

Skills: `init`, `start`, `stop`, `job`, `reset-breaker`.

### [`p-chat`](./plugins/p-chat/)

A deliberately dumb Telegram channel with a bundled `pchat` CLI — the mouth and ears of a Claude Code loop, never the brain. Runs as a p-shed job guard: scripted `/commands` are answered directly (no Claude launch, works even when Claude is usage-limited); a pending free-text question makes the guard request a Claude responder launch. Fail-closed chat allowlist, at-least-once delivery, zero dependencies.

Skills: `init`, `respond`.

## Tests

```bash
npm install   # first time only
npm test
```

Two layers run together. The marketplace layer is static: it validates `marketplace.json`, every `plugin.json`, every `SKILL.md`, template references, and cross-skill invariants (see [`docs/superpowers/specs/2026-05-12-marketplace-tests-design.md`](./docs/superpowers/specs/2026-05-12-marketplace-tests-design.md) for the rationale). On top of that, each bundled CLI has its own suite that runs the real binary in a temporary repo and uses local fixtures — a fake Confluence transport, throwaway wikis and task stores — so behaviour is covered, not just structure.

No test needs the network or a logged-in service. The few that do talk to a real Confluence are skipped unless their environment variables are set.

Every run also writes `.vitest-last-run.json` (gitignored) beside the console output. When a run fails — especially one of the e2e tests that spawn processes and fail rarely — read that file instead of scrolling back:

```bash
node -e "for (const f of JSON.parse(require('fs').readFileSync('.vitest-last-run.json','utf8')).testResults) for (const a of f.assertionResults) if (a.status==='failed') console.log(f.name, '::', a.fullName)"
```

## Validate

Run Claude Code's own validator on the marketplace and every plugin. Requires the `claude` CLI on PATH.

```bash
npm run validate
```

Complements `npm test`: tests catch structural drift in our manifests/skills, `validate` catches whatever the `claude` CLI itself rejects.

## Repository layout

```
.
├── .claude-plugin/
│   └── marketplace.json     ← catalog of plugins in this marketplace
├── plugins/
│   ├── p-wiki/              ← one directory per plugin
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── README.md
│   │   ├── docs/superpowers/  ← per-plugin design spec + implementation plan
│   │   ├── skills/
│   │   └── tools/           ← Node-based CLI helpers used by skills
│   ├── p-flow/              ← task development flow + spec templates
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── README.md
│   │   ├── CLAUDE.md        ← contributor guide (architecture decisions, invariants)
│   │   ├── hooks/           ← SessionStart hook that surfaces the flow
│   │   ├── docs/            ← per-task design specs + implementation plans
│   │   └── skills/          ← reviewer prompts live inside their requesting skill
│   ├── p-tasks/             ← two-level task tracker with FS / Jira destinations
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── README.md
│   │   ├── docs/
│   │   ├── skills/
│   │   └── tools/
│   ├── p-statusline/        ← custom Claude Code status line renderer
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── README.md
│   │   ├── skills/
│   │   └── statusline/      ← the renderer script copied to ~/.claude/p-statusline/
│   ├── p-graph/             ← local code knowledge graph (tree-sitter → SQLite)
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── README.md
│   │   ├── docs/superpowers/  ← per-plugin design spec + implementation plan
│   │   ├── skills/
│   │   └── tools/           ← the pgraph CLI + vendored web-tree-sitter + grammars
│   ├── p-shed/              ← scheduler/launcher for Claude Code headless runs
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── README.md
│   │   ├── skills/
│   │   └── tools/           ← the pshed CLI (timer, guard, breaker, log rotation)
│   └── p-chat/              ← dumb Telegram channel (pchat CLI + p-shed guard)
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── README.md
│       ├── skills/
│       └── tools/           ← the pchat CLI (config, queue, api, send, core)
└── README.md                ← this file
```

To add a new plugin: create `plugins/<new-plugin>/` with its own `.claude-plugin/plugin.json` and skills, then add a new entry to `.claude-plugin/marketplace.json`.

## Local development

```bash
claude --plugin-dir C:/path/to/x/plugins/p-wiki
```

Each plugin can be loaded standalone for development with `--plugin-dir`.
