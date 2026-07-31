🧰 **Four plugins for Claude Code: p-wiki, p-graph, p-tasks, p-flow**

These plugins are not built to make life easier for a human. They are built for Claude. They give the agent what it does not have by default: memory of the project's decisions, a map of how the code connects, a work plan that lives outside the chat, and a process that carries a task from idea to a finished change.

Without them the agent does the same work but pays for it three times: in context (the window fills up with file reads), in limits and time (the same tokens are spent again in every new session), and in quality (what the agent did not find, it does not fix). Each section below says what happens without that plugin.

Catalog: https://github.com/perky-team/claude-plugin

---

⚙️ **Install**

Two steps: add the catalog, then install the plugins you want.

```
/plugin marketplace add perky-team/claude-plugin
/plugin install p-wiki@perky.team
/plugin install p-graph@perky.team
/plugin install p-tasks@perky.team
/plugin install p-flow@perky.team
```

`/plugin install` opens the plugin's card and asks for an install scope:

- **user** — for you, in every project (the usual pick)
- **project** — for everyone on this repo; the entry goes into `.claude/settings.json` and is committed
- **local** — for you, in this repo only

From a shell, without the prompt: `claude plugin install p-wiki@perky.team --scope user` (`user` is the default).

After installing, run `/reload-plugins` so the plugins load in the current session.

Then each repo you work in needs a one-time setup: `/p-wiki:init`, `/p-graph:init`, `/p-tasks:init`, `/p-flow:init`. That step writes the plugin's files into the project, plus the rule that tells Claude the plugin is available here.

The plugins are independent: install one now and add the others later.

---

🕸 **p-graph — a map of the code instead of grep**

*What it does:* indexes the repo into a local SQLite database — symbols (functions, methods, classes, types) and the links between them: calls, imports, `#include`. Languages: TypeScript/JavaScript, Go, C++, Python.

*Who uses it:* Claude runs the queries. The rule installed by `/p-graph:init` tells it to use the graph instead of grep for structural questions. You can also ask directly with `/p-graph:query`.

**What happens without it**

The agent answers "what breaks if I change this function" with grep. Measured on the repo of these plugins — 320 files, 1261 declarations (functions, methods, classes, types), 21 thousand links between them. The question was about the function `parseFrontmatter`:

```
pgraph impact parseFrontmatter   →  11 lines, 1.4 KB  (~350 tokens)
                                    every affected place at once, with file and line

grep -rn parseFrontmatter        →  24 lines across 6 files
                                    not an answer: imports, the definition, some calls
                                    to get the answer the agent opens those 6 files
                                    = 1813 lines = 76 KB (~19,000 tokens)
                                    and repeats the walk for every caller it finds
```

- **context and limits:** ~350 tokens against ~19,000 for one question — 50 times more, and that is only the first round of the walk
- **quality:** grep misses things that break. The graph's list includes `syncToMirror` — it breaks through a chain via another function, but the name `parseFrontmatter` does not appear in it at all, so grep never finds it and the agent never looks there
- **false hits:** the name `readConfig` is defined in five plugins of this catalog. Grep returns 40 matches mixed together and the agent cannot tell which of the five is meant. In that situation the graph creates no link at all — "ambiguous" beats a confident wrong answer

*Commands*

- `/p-graph:init` — index the repo
- `/p-graph:query "who calls handleOrder"` — a plain question, an answer with `file:line` references
- `/p-graph:sync` — full rebuild after a big refactor
- `/p-graph:help` — the cheat-sheet

The exact commands underneath: `callers` (who calls it), `callees` (what it calls), `impact` (what breaks along the whole chain), `trace` (a call path from A to B), `context` (a symbol and its neighbours).

Everything is local: the database sits in `.pgraph/`, there is no server, and the code never leaves the machine. The graph refreshes itself before a query.

*Requirement:* Node 22.5 or newer.

---

📚 **p-wiki — project knowledge as context for the agent**

*What it does:* keeps a wiki under `docs/wiki/`. The source is stored as it is, and linked pages are built from it.

*Who uses it:* Claude reads it. It finds the right pages itself and answers from them, with links back to the source. You take part twice: you hand over a source, and you read the answer.

**What happens without it**

Knowledge lives only in the chat, and a chat does not last: `/compact` replaces it with a structured summary, `/clear` wipes it completely. After that:

- **context and limits:** every new session starts by rebuilding the picture — the agent reads code and documents again to work out what was decided. The same tokens are spent again, from scratch, every time
- **quality:** code shows *how* something was done, not *why* that option was chosen and what was rejected. Whatever is not written down, the agent fills in itself — that is where "improvements" come from that undo a deliberate past decision
- **across repos:** if the spec is in one repo and the code in another, the agent simply does not know about the spec. A human retells it in the prompt — from memory, every single time

**What sources it accepts**

- a web page — `/p-wiki:ingest https://...` (the page is turned into markdown)
- a file outside the repo — `/p-wiki:ingest C:\docs\brief.pdf` (text files and PDFs)
- a paste from the chat — `/p-wiki:ingest -` (takes the last large paste in the conversation)
- a file inside the repo — `/p-wiki:compile docs/specs/billing.md` (a spec, README, ADR; no copy is made, pages are built straight from the file)

**How knowledge reaches other repos**

Your own wiki and other wikis work at the same time. Yours is the primary one — writes go there. Others are attached as read-only sources, as many as you like, and nothing is ever written back to them, so they cannot drift apart.

```
   repo-specs                 repo-service-a            repo-service-b
   (the specs wiki)           docs/wiki/                docs/wiki/
   docs/wiki/  ──────────►   source: specs    ◄──────  source: specs
                              (read only)               (read only)
```

Search order: your own wiki first, its hits come first in the answer, then the external sources in the order they were attached. Every hit is tagged with its source. The merged list is cut to the limit (10 results by default), so with plenty of local hits the external ones may not make it into the answer at all. An unreachable source does not break the search — you get a warning plus the results from the rest. Need one specific page from one specific wiki, you read it directly by naming the source.

Example: the specs live in their own repo, the code lives in the microservice repos. You attach a source through `/p-wiki:init` — nobody writes the config by hand. The same command covers both cases: when it creates a wiki it asks about other wikis at the end, and on a wiki that already exists you simply run it again — it sees everything is in place and only offers the source step.

Init asks for a short name for the source and where the other wiki lives. Three cases follow:

- **the specs repo is cloned next to yours** — files are read directly, nothing needs publishing
- **no clone, read from GitHub or GitLab** — the specs repo publishes a `docs/wiki/index.json` bundle once (best built in CI), and the microservices read only that file
- **the other wiki is in Confluence** — its settings are copied out of its own config, so nothing is retyped

The source is checked before anything is written. If it is unreachable — wrong path, a typo in the repo name, a missing token — nothing goes into the config, and you get an explanation of what exactly is wrong.

If you prefer the command line: underneath this is `pwiki source add <name> --kind=fs --path=<path>` (or `--kind=github --owner=… --repo=…`, or `--from-config=<the other .pwiki.json>`); in full, `node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" source add …`.

From then on, while working on the microservice's code, Claude sees the spec from the other repo as part of its context: asked how a fee is calculated, it finds the page in the specs wiki and answers from it, with a link to the source.

Kinds of source you can attach: `fs` (a wiki on disk), `github`, `gitlab`, `http` (from a published bundle), `confluence` (someone else's space). For private repos the token comes from an environment variable and never enters the config.

**Where the pages themselves live**

Markdown in git, Confluence Cloud, or both: one store is primary, the rest are mirrors refreshed by `/p-wiki:sync` (one-way, and running it again breaks nothing).

**The other commands**

- `/p-wiki:query "question"` — an answer from accumulated knowledge, with citations
- `/p-wiki:lint` — checks dead links, orphan pages, stale entries, changed sources
- `/p-wiki:reconcile` — settles contradictions after a source changed; anything genuinely unclear stays flagged for a human

---

✅ **p-tasks — the work plan, kept out of the chat**

*What it does:* a task tracker: task → sub-tasks, statuses `todo` / `in_progress` / `done`, and "blocked by" links. A sub-task also holds its acceptance criterion and the files it should touch. The data sits in `docs/tasks/tasks.yml` in the repo, in Jira, or in both.

*Who uses it:* Claude keeps the tracker — it marks a step in progress itself and closes it after checking. You look at the same file or at Jira, and edit the plan with commands.

**What happens without it**

A 12-step plan lives in the chat, in the same place as file reads and test output. When the window fills up, auto-compact replaces the chat with a summary. The plan gets squeezed in that summary, and acceptance criteria and file lists never make it in.

- **context:** a long plan takes up room in the window the whole time, competing with files and tests. On disk, a plan takes up nothing until it is read
- **limits:** after `/clear`, a restart, or a compaction, the agent rebuilds the picture — looking through git and the code again to work out where it stopped. That is paid work done twice
- **quality:** step details drop out of the summary, so part of the work quietly never happens and "done" is claimed too early. An interrupted step with no "in progress" mark looks either unstarted (the agent redoes finished work) or finished (leaving a hole)

**Why this beats simply asking Claude to keep a TODO file**

A file in the repo gives you exactly one thing — the plan survives `/clear`. Everything else is left to the model, and here is what changes:

- **code does the edits, not the model.** `set --status done` changes one field. An agent editing markdown first reads the whole file into context, then rewrites it in full — that is tokens on every step, plus a chance to lose part of the text
- **the format holds still.** A status can only be `todo` / `in_progress` / `done`, anything else is rejected. Field order is fixed, so git shows a proper diff — one line, not a reshuffled file. In a free-form file the agent writes checkboxes one session and a table the next
- **blockers are checked by machine.** A link to a task that does not exist is rejected, a ring of "A waits for B, B waits for A" is rejected before writing, and "what's next" never offers a step whose blockers are still open. In a file, the line "blocked by: …" is just text the agent can read and ignore
- **a ready answer instead of reasoning.** "What's next" is a query: started work first, then sub-tasks of the started task, then in order. With a file the agent re-reads everything and decides for itself each time — paying tokens and occasionally getting it wrong
- **a step has fields, not a paragraph of prose.** Acceptance criterion, files, kind of work, where it came from. That is why a review finding is distinguishable from a plan step (`origin: code-review:blocker`), and a rejected finding keeps the reason it was rejected. In a file that is a convention, and conventions break first
- **Jira with one command.** From markdown, there is no way

To be fair: for a one or two step job a plain file is enough. The tracker starts to win where there are many steps, the work gets interrupted, and review findings pile onto the plan.

*Commands*

- `/p-tasks:init` — create the tracker, choose the store (file or Jira)
- `/p-tasks:add` — add a task or sub-task
- `/p-tasks:set` — change status, title, description, blockers
- `/p-tasks:next` — what to do next (started work comes first)
- `/p-tasks:list` — the whole plan in order
- `/p-tasks:summary` — what is already done
- `/p-tasks:sync` — push the state to Jira

The `in_progress` status is the "we stopped here" mark: work continues from that exact step, without walking back over what is finished. An acceptance criterion on a sub-task means the agent checks itself against what was written, not against its own idea of the job.

---

🎬 **p-flow — a development process: one feature from idea to MR**

*The idea:* work moves in units. One feature or one bug is one branch, one spec folder, one plan, one MR. Nothing happens "for the project in general": first you pick what exactly is being done, and the whole path then runs inside that unit. There are five types: feature, bug, hotfix, routine work, docs.

*What it does:* carries that unit of work through the stages — discussion → spec → plan → implementation → verification → review → push, plus a ready-to-copy command for creating the MR.

*Who uses it:* Claude itself. The plugin installs a rule in the repo, and on every fresh session — and after `/clear` — it reminds the agent which stages exist, so nothing has to be guessed from keywords. The decisions stay with you: branch type, answers while the spec is discussed, approving the spec, how the plan gets executed, what to do with review findings, and finishing up.

**What happens without it**

The whole task runs in one context: discussion, code reading, edits, test output, errors, retries. By mid-implementation the window is full.

- **context:** auto-compact fires in the middle of the work and replaces the chat with a summary — part of what was agreed about the implementation is lost exactly when it is needed
- **limits:** code written without a spec goes the wrong way, and the second attempt costs as much as the first. Rework is the most expensive line in the bill
- **quality:** "done" without running tests means "I think so". A review inside the same context that wrote the code is weak: the agent re-reads its own reasoning and agrees with it

How p-flow changes this: by default each plan step runs in a separate fresh subagent (there is also the option to do everything in the current session — your choice). Per Claude Code's documentation a subagent works in its own context window, its file reads never enter the main conversation, and only the result comes back out. So the main context does not grow from step to step, and step ten runs in a window as clean as step one. The review is done by a separate agent too — it sees the diff and the spec but not the author's reasoning, so it does not agree with it automatically.

*Commands*

- `/p-flow:init` — once per repo: rules, spec templates, and a block on reading files with secrets (`.env`, keys, tokens). As a second step it offers to discuss the list of upcoming features and creates a spec stub for each
- `/p-flow:task-start <task-name> [--worktree]` — asks for the branch type (`feature` / `bugfix` / `hotfix` / `chore` / `docs`), checks that the working tree is clean and the names are free, creates the branch and the task folder, and starts the spec discussion. With `--worktree` the task moves into a separate copy of the repo next to yours
- `/p-flow:task-end` — counts the open steps, checks whether tests were run, pushes the branch, and prints ready `gh` / `glab` commands. It never runs them itself, and it refuses to work on `main`

Rules that kick in along the way: a failing test first, then the code; no claiming "done" without test output; a bug is worked through by method (reproduce → hypothesis → test it → fix the cause).

Review happens in two places. In the default mode, after every step: the step is checked both against the spec and for code quality, and it does not count as done until the findings are closed. At the end of the task, two large independent reviews of the whole branch: one on code quality, one on matching the spec. Findings arrive by importance — blockers, suggestions, nits — and you decide on each one: fix, defer, or reject.

**What stands out**

- **the spec is files in the repo, not a chat message.** `specs/<name>/specification.md` always exists; next to it appear `feature.feature` if behaviour scenarios were captured, and `adr.md` if there was an architectural decision. All of it stays in git and outlives any session
- **a hard gate on the spec.** Until you approve the spec there is no plan and no code
- **a separate agent proofreads the spec.** It looks for logical errors, contradictions, and gaps, and fixes the spec itself — the one place where a checking agent may write to files. At most three passes over blockers, and anything unclear goes to you as questions, one at a time
- **when choosing an approach the agent may consult outside sources.** A library, a protocol, a technique new to this codebase — then it reads the docs or searches, and records the choice with links in `adr.md`. Only for that kind of task, never for routine work, and never automatically
- **"verified" is backed by a file on disk.** A successful check leaves a stamp with the time; finishing the task notices when there was no check, or when it is older than the last commit, and says so. If the repo has no tests, the agent must say that plainly and leaves no stamp
- **checking agents only read.** Neither the code review nor the spec review edits code — their findings become separate work items, and a rejected finding keeps the reason it was rejected
- **an interrupted step is not blindly redone.** A step is marked "in progress" before it starts, so after a crash it is clear where things stopped: the agent checks what exists against the acceptance criterion and finishes it, rather than starting over
- **step artifacts are handed over as files.** The brief and the report for each step sit in the task's work folder; they also serve as the journal for resuming, and they are cleared only after a successful push. Progress meanwhile shows in Claude Code's task list (`Ctrl+T`)
- **names and commits follow rules.** Branches are `<type>/<name>`, commits use Conventional Commits, and the MR title is built from history: one commit means its own subject, several mean a combined title typed by the dominant one
- **works with a tracker and without one.** No p-tasks — the plan is written as `specs/<name>/plan.md` next to the spec, with steps ticked off as checkboxes. With p-tasks — the plan moves into the tracker entirely (a task plus a sub-task per step) and no plan file is created at all, so the step list never lives in two places. Installing the tracker is optional: without it, behaviour is exactly what it was before the tracker existed
- **a plan is 5–15 steps, each with an acceptance criterion.** Writing a step without one is forbidden; if it takes more than fifteen, the work is declared too large for one task and split up
- **the other links are just as optional.** With p-wiki, the task's decisions land in the wiki; with p-graph, what breaks from the change informs how the plan is split. None of the three plugins is required for p-flow to work

*Requirement:* Sonnet or a stronger model for the reviews.

---

🔗 **How they fit together**

```
              p-flow — carries a task from idea to MR
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
     p-tasks           p-graph            p-wiki
    plan and          what breaks       decisions and
    statuses,         when you          project
    step by step      change it         context
```

The link is one-way and optional: p-flow knows about the other plugins, but each one works on its own.
