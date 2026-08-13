# perky.team plugins

A Claude Code plugin marketplace. Plugins live under `plugins/<name>/`.

## Install the marketplace

Open Claude Code CLI and add this repository as a marketplace, then install any plugin from it:

```text
/plugin marketplace add perky-team/claude-plugin
/plugin install <plugin-name>@perky.team
```

`<plugin-name>` is one of `p-wiki`, `p-flow`, `p-tasks`, `p-statusline`, `p-graph`, `p-shed`, `p-observe`, `p-chat` (see below).

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

A custom Claude Code status line — the two-line bar at the bottom of the terminal. Activated via the `install` skill, which copies the renderer script to `~/.claude/p-statusline/` and wires `statusLine` in `~/.claude/settings.json`.

The status line shows:

**Line 1 — `context | rate limits | git`**
- **Context window** — usage `%`, consumed tokens (e.g. `64k`), and cache-hit `%`. The percentage and token count share a green → red ramp that warms as the window fills. Shows a dim `-%` placeholder before the first API response.
- **Rate limits** — `5h` and `7d` usage windows side-by-side, each as `XXX%[countdown]` with reset countdown (e.g. `5h  25%[ 3h12m]`). Fixed 31-character width: percentages right-aligned, countdowns padded so the `%`, `[`, `]` landmarks line up. `n/a` (padded) until Claude Code reports data.
- **Git** — branch name (magenta), `*` for uncommitted changes, `wt:` marker inside a linked worktree, and `↑N↓M` commits ahead-of / behind upstream.

**Line 2 — `model | path | RAM`**
- **Model + effort** — bare model display name with effort level (`Opus 4.7 xhigh`).
- **Project path** — the project's launch directory. Capped at the limits-section width: if longer, truncated from the start with a `...` prefix so the folder name (end of the path) stays visible, and the second `|` separator vertically aligns with line 1.
- **RAM** — system memory usage with the same green → red ramp as the rate-limit %.

The leading segments of both lines (context / model+effort) are padded so the first `|` separator vertically aligns.

Skills: `install`, `help`.

### [`p-graph`](./plugins/p-graph/)

A local code knowledge graph with a bundled `pgraph` CLI. Indexes the project (TypeScript/JavaScript, Go, C++, Python) into a SQLite graph of symbols and their call/import/extend edges, so Claude answers structural questions — where a symbol is defined, what calls it, what breaks if it changes, how one symbol reaches another — from the index instead of grepping. Fully local, no MCP server.

Why it matters: `impact` returns the whole transitive set in one small answer, including callers that never mention the symbol's name and so are invisible to grep. Ambiguous names stay unresolved rather than linked to a guess, so the graph never invents an edge. Queries refresh the changed files first, so day-to-day freshness needs no manual sync.

**Measured against a grep-only agent: fourteen public repos, 52 structural questions, 312 runs, three
runs a side.** Below are the 36 "who calls X" questions — the shape grep is best at — split by
language and by how big the repository is. The size line falls between leveldb (132 files, 9k call
edges) and caddy (326 files, 24k).

Big repositories:

**Go** — hugo 930 files / 55.5k call edges, caddy 326 / 23.6k · 5 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 226 of 228 | 226 of 228 | tie |
| Invented | 51 | **17** | **−67%** |
| Cost per question | $0.338 | **$0.290** | **−14%** |
| Time per question | 72 s | **61 s** | **−15%** |

**TypeScript** — nest 1,728 / 38.3k · 5 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 177 of 177 | 177 of 177 | tie |
| Invented | 0 | 0 | tie |
| Cost per question | $0.142 | **$0.130** | **−8%** |
| Time per question | **20 s** | 22 s | +8% |

**C++** — rocksdb 1,454 / 318.7k · 3 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | **114 of 114** | 108 of 114 | **grep** |
| Invented | 0 | 0 | tie |
| Cost per question | $0.127 | **$0.093** | **−26%** |
| Time per question | 21 s | **14 s** | **−34%** |

**Python** — django 3,036 / 195.1k · 3 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 108 of 108 | 108 of 108 | tie |
| Invented | 0 | 0 | tie |
| Cost per question | **$0.097** | $0.130 | +34% |
| Time per question | **17 s** | 20 s | +18% |

Small repositories:

**Go** — gin 99 / 9.2k · 2 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 105 of 108 | **108 of 108** | **p-graph** |
| Invented | 0 | 0 | tie |
| Cost per question | $0.170 | **$0.160** | **−6%** |
| Time per question | 45 s | **31 s** | **−32%** |

**TypeScript** — axios 240 / 14.3k, got 85 / 14.3k · 4 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | **282 of 282** | 269 of 282 | **grep** |
| Invented | **0** | 2 | **grep** |
| Cost per question | $0.195 | **$0.185** | **−5%** |
| Time per question | 32 s | **29 s** | **−11%** |

**C++** — spdlog 152 / 8.2k, leveldb 132 / 9.2k, re2 89 / 8.3k · 9 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 476 of 480 | **477 of 480** | **p-graph** |
| Invented | 0 | 0 | tie |
| Cost per question | **$0.302** | $0.328 | +8% |
| Time per question | **53 s** | 58 s | +11% |

**Python** — flask 83 / 3.9k, httpx 60 / 4.2k, requests 37 / 2.7k · 5 questions

| | grep | p-graph | Gap |
|---|---|---|---|
| Call sites found | 135 of 135 | 135 of 135 | tie |
| Invented | 0 | 0 | tie |
| Cost per question | $0.180 | **$0.172** | **−4%** |
| Time per question | 34 s | **30 s** | **−12%** |

**Read these tables for accuracy, not for size.** Size decides nothing here: big C++ runs 26% cheaper
and big Python 34% dearer, and on this question shape the study's own answer is that cost is noise
(−2%, 0.3 standard errors). What does hold is that p-graph invents a third as many call sites, and all
51 of grep's inventions are on big Go.

The size effect lives on the other question shape — "what breaks if I change X", "how does X reach Y".
There p-graph is **43% cheaper, 51% faster and takes 57% fewer steps** on the big repositories, and
26% dearer on the small ones, now measured on Go, C++ and Python alike.

One known defect shows up above: C++ finds 108 of 114 because a receiver declared as a *subclass*
does not reach a method defined on its base class — and the answer still prints `complete`.

Every row of every language is in the plugin's own
[README](./plugins/p-graph/README.md#every-row-per-language); how it was measured, and every pass that
went the other way, is in [docs/measured-benefit.md](./plugins/p-graph/docs/measured-benefit.md).

Requires Node ≥ 22.5 (built-in `node:sqlite`).

Skills: `init`, `sync`, `query`, `help`.

### [`p-shed`](./plugins/p-shed/)

Scheduler/launcher for Claude Code headless runs. `p-shed` schedules jobs (cron timer + folder + prompt) and, on each due minute, launches `claude -p` in the job's folder. It is a pure scheduler: it does not store or resolve work items and installs no rules — what to do lives entirely in each job's prompt and in the target folder.

Skills: `init`, `start`, `stop`, `job`, `reset-breaker`.

### [`p-observe`](./plugins/p-observe/)

Zero-touch realtime observability with a bundled `pobserve` CLI. Watches the runtime state of `p-shed`, `p-tasks`, `p-graph`, and `p-wiki` in the current repo — without modifying them — and emits a normalized, human-readable event stream (`pobserve watch`), a one-shot snapshot (`pobserve status`), and an opt-in headless journal (`pobserve capture`). Fully local, zero dependencies.

Skills: `init`, `watch`, `tui`, `help`.

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
│   ├── p-chat/              ← dumb Telegram channel (pchat CLI + p-shed guard)
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── README.md
│   │   ├── skills/
│   │   └── tools/           ← the pchat CLI (config, queue, api, send, core)
│   └── p-observe/           ← zero-touch realtime observability (pobserve CLI)
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── README.md
│       ├── skills/
│       └── tools/           ← the pobserve CLI (adapters, bus, journal, renderers)
└── README.md                ← this file
```

To add a new plugin: create `plugins/<new-plugin>/` with its own `.claude-plugin/plugin.json` and skills, then add a new entry to `.claude-plugin/marketplace.json`.

## Local development

```bash
claude --plugin-dir C:/path/to/x/plugins/p-wiki
```

Each plugin can be loaded standalone for development with `--plugin-dir`.
