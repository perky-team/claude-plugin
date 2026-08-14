# Design: an A/B harness that compares p-tasks with rival task trackers

**Date:** 2026-08-14
**Status:** Approved, not implemented
**Targets:** `plugins/p-tasks` — a new measurement script, no change to shipped behavior
**Sibling:** `plugins/p-graph/scripts/measure-agent.mjs` (same idea, different subject)

---

## 1. Why

p-tasks has never been measured against anything. Rival trackers for coding
agents are popular and close in design — beads has 26k stars and the same core
idea: tasks in the repo, blockers between them, "give me the next unblocked
item". A feature list cannot say which is better, because on paper all of them
do the same thing.

The question this study answers is narrow and practical:

> **Should we keep p-tasks, or move to a rival?**

Everything else — a published write-up, a list of p-tasks defects to fix — is a
by-product we can take from the same runs later.

## 2. What a task tracker is for

An agent forgets everything when its session ends. A tracker is the memory that
survives that. So the thing to measure is not "can it store a task" but:

**Does a long job, spread over many fresh sessions, finish faster and with
fewer losses when the agent has this tracker?**

That shapes every choice below.

## 3. Scope

In scope:

- three arms: no tracker, p-tasks, beads
- one polygon repository and one feature
- mechanical scoring by a hidden test suite

Out of scope, deliberately:

- **Jira and any other external mirror.** The user ruled it out. This study is
  about the core: storage, blockers, and picking the next item.
- `ptasks guard` and the p-shed loop. No rival has it, so it cannot be compared.
- Backlog.md and Task Master. Backlog.md's edge is its UI, which an agent never
  opens. Adding a fourth arm costs a third more for little new information.
- Any UI at all.

## 4. Arms

Three arms over the same polygon, the same feature and the same model.

| Arm | What is installed | What survives a session end |
|---|---|---|
| `none` | nothing. No `CLAUDE.md`. The agent keeps only its built-in todo list, which dies with the session | the working tree, and whatever the agent chose to commit |
| `ptasks` | the plugin via `--plugin-dir`, and the rule from `p-tasks.rule.md.tpl` written to `CLAUDE.md` | `docs/tasks/tasks.yml` |
| `beads` | the `bd` binary, `bd init`, and the beads rule in `CLAUDE.md` | `.beads/` |

Everything else is held equal: same seed repository, same `SPEC.md`, same model
(`sonnet`), same session prompt, same per-session dollar cap.

The user's own plugins (p-graph, p-wiki, p-statusline, the Go language server)
are switched off in every arm through a settings file, exactly as p-graph's
harness does. Left alone they would quietly join the `none` arm and void the
whole comparison.

**Known and accepted:** an arm differs by its rule text as well as by its
storage. The rules tell the agent how to work, not only where to write. That is
what installing the plugin actually gives a user, so it is the honest unit of
comparison — and it is the same choice p-graph's study made.

### The tracker starts empty

The harness does **not** pre-load the tracker with the ten requirements. The
agent reads `SPEC.md` and creates its own items.

Pre-loading would hide the very cost we want to see: keeping a tracker up to
date is work, and a study that does that work for the agent flatters both
tracker arms. It would also mean we translate the spec into each tracker's
schema by hand, which is us doing the job instead of the agent.

## 5. Polygon

A small but real JavaScript project, about 500–800 lines. We write it once and
freeze it as a seed commit.

**It has no dependencies at all.** Both the visible and the hidden tests use
`node:test`, which ships with Node. That removes `npm install` from every part
of this study: the agent's copy needs no setup, a snapshot is a few hundred
kilobytes instead of a few hundred megabytes, and scoring is one `node --test`
against a copied directory.

It ships a `SPEC.md` describing one feature as about ten requirements with real
dependencies between them — for example: load a config file → validate it →
map CLI flags onto it → error messages → JSON output → exit codes. Later
requirements cannot be finished before earlier ones, so a tracker's blocker
graph has something true to hold.

The seed also has a small **visible** test suite, so the agent can check itself.
The score does not come from it.

### `SPEC.md` pins the interface, or the study measures nothing

The hidden tests import the code. If the agent writes a correct implementation
under names of its own choosing, every hidden test fails on an import error and
the run scores zero for a reason that has nothing to do with the tracker. This
is the single most likely way to end up with a pile of meaningless numbers.

So `SPEC.md` states, as part of the requirements themselves:

- the exact module paths the feature must live in (`src/config.js`, …)
- the exact names and signatures it must export
- the exact shape of what those functions return and throw

The hidden suite imports **only** those paths and names. Anything the spec does
not pin down, the tests do not touch. A requirement the tests check but the
spec does not state is a bug in the study, not a failure by the agent.

### Hidden acceptance tests

The suite that decides the score lives outside the agent's copy, in
`plugins/p-tasks/scripts/polygon-acceptance/`. It is never copied into the
directory the agent works in. Scoring happens on a **snapshot copy** of the
working tree, so no session can ever read the tests or shape its code to them.

Two rules keep this suite honest:

1. **Every test names the requirement it checks** (`R3`, `R7`, …). A test that
   cannot cite a requirement in `SPEC.md` does not belong in the suite. This is
   the fix for the failure mode the p-graph study hit three times: a ground
   truth that is quietly wrong.
2. **No clock, no network, no randomness.** A flaky test would read as a
   regression, which is the metric that matters most here.

The agent may edit or even delete `SPEC.md` and the visible tests — nothing
stops it, and the harness does not put them back. The hidden suite checks the
requirements as they were written at the seed, so an agent that rewrites the
spec into something easier scores no better for it.

## 6. The run

```
for each arm, for each run r = 1..5:
    fresh clone of the seed        ← the arm is installed here, once
    for session s = 1..10:
        claude -p "<the same sentence every time>"
               --model sonnet --max-budget-usd 5
        copy the working tree to snapshots/<arm>-<run>/s<NN>/   (no node_modules)
        run the hidden suite against that copy
        append one line to runs.jsonl
        stop early if every hidden test is green
```

### The per-session cap is a safety net, not a schedule

$5, not $2. The cap must almost never bind, and every session records whether
it did (`hit_cap`).

A cap that binds is worse here than in p-graph's study, and it binds unevenly.
A tracker arm spends part of each session on tracker upkeep, so it reaches the
cap with less code written — and the CLI stops wherever it is, which can be
halfway through an edit. Broken half-written code then shows up as a
**regression**, the one metric this whole study exists to read. A cliff in the
middle of the measurement instrument is not acceptable.

If `hit_cap` is true in more than one session in twenty, the regression numbers
are void and the cap has to go up before anything is published.

### Snapshots

The snapshot copies the whole working tree, including `.git` — if the agent
committed, that is evidence. `node_modules` is skipped if it appears at all; the
polygon has no dependencies, so it should never be there, and an agent that
installs something is not going to have it counted against its disk.

Scoring copies the hidden suite into the snapshot, runs `node --test`, reads the
TAP output, and throws the scoring directory away. The agent's own directory is
never touched.

The prompt is identical in every session and every arm, and says nothing about
what has already been done:

> Continue the work on the feature described in SPEC.md.

The harness never commits and never touches the polygon's git history. A commit
by the harness would hand every arm a free session-by-session diary — memory
the study is supposed to be measuring, not supplying. If the agent commits by
itself, that is its own choice and it counts.

Stopping early when everything is green saves money and gives us the
"sessions to done" number for free.

### Failure handling

- A session that errors (API failure, budget cap) is recorded with its error and
  the run continues.
- Three failed sessions in a row abort that run and mark it aborted; it is not
  scored as a zero.
- `runs.jsonl` is append-only and never repeats a finished session, so the
  harness can be stopped and restarted, like p-graph's.

## 7. Metrics

All of them are mechanical. No model judges anything.

| Metric | How it is counted | What it shows |
|---|---|---|
| Done | share of hidden tests green at the last session | the headline |
| Sessions to done | first session where all are green, else "did not finish" | speed |
| **Regression rate** | tests that were green in session *k* and red in *k+1*, divided by the number of session hand-overs the run actually had | lost memory — the metric this study exists for |
| Churn | sum of the diffs between neighbouring snapshots, divided by the diff between the seed and the last snapshot | work done twice |
| Cost | sum of `cost_usd` over the run | price |
| Tracker tax | token counts per session from the CLI's `usage` field; the gap between arms is the tax. If the CLI does not return `usage`, cost per session stands in for it | what the rule and the tool output cost every session |

Churn of 1.0 means every line was written once. Churn of 3.0 means the same
lines were rewritten three times over.

**A rate, not a count.** A run that finished at session 4 had three hand-overs
between sessions; one that ran all ten had nine. Counting raw regressions would
hand the faster arm a better score for being faster — the same fact twice, once
as speed and once as reliability.

This is a real improvement on the p-graph harness: there, a second model had to
read each answer and extract the claims. Here the score is the TAP output of
`node --test`. It is free, exact, and identical every time.

## 8. Not disturbing the p-graph measurement

A p-graph measurement may be running at the same time. The harness therefore:

- uses its own work directory, `%TEMP%\ptasks-measure`, never `pgraph-measure`
- uses its own settings file, `ptasks-arm-settings.json`
- runs sessions strictly one at a time, so it does not fight the other study for
  API rate limits
- lives in the `tracker-ab` git worktree

## 9. Pilot first

Before spending the full budget: **two** arms — `none` and `ptasks` — one run
each, ten sessions each. About $10.

One arm is not enough to calibrate. If only `ptasks` is piloted and it lands at
85%, that looks healthy — and the polygon can still be so easy that `none` also
lands at 85% and the whole study is void. The gap is the thing being calibrated,
so the gap has to be in the pilot.

The pilot passes on both counts:

| Check | Pass | If it fails |
|---|---|---|
| `ptasks` ends between 40% and 90% green | the feature is the right size | below 40% cut requirements, above 90% add them |
| `ptasks` and `none` differ by at least 15 points | there is something to measure | rewrite the feature so later requirements truly depend on earlier ones |

A pilot that fails is cheap. A full study over an uncalibrated polygon is $100
that answers nothing.

## 10. Cost

| | Sessions | Expected |
|---|---|---|
| Pilot | 2 arms × 1 run × 10 = 20 | ~$10 |
| Full study | 3 arms × 5 runs × 10 = 150 | $60–100 |

The per-session cap no longer sets the ceiling — at $5 a session it would allow
$750, which is not a ceiling worth quoting. **`--max-total-usd` is the real
ceiling**, default $150: the harness adds up what it has spent and stops. If the
study passes $150 while the estimate was $60–100, something is wrong and a human
should look before more money goes out. Raise the flag to carry on.

Five runs a side, not three. p-graph's README already records that three runs a
side is too few to read its accuracy rows closely, and feature work varies more
than answering a question.

## 11. Files

```
plugins/p-tasks/scripts/
  measure-tracker.mjs        the CLI
  measure-tracker/
    arms.mjs                 install an arm into a fresh clone; preflight
    session.mjs              run one session, record what it cost
    snapshot.mjs             copy the tree, measure churn between copies
    score.mjs                run the hidden suite, read TAP
    metrics.mjs              pure sums: done, sessions to done, regression rate
    report.mjs               the tables
  beads-arm-rule.md          the rule text the beads arm writes to CLAUDE.md
  polygon/                   the seed project, committed, no dependencies
    SPEC.md                  the feature, ~10 requirements, interfaces pinned
    src/ tests/              stubs and the visible suite
  polygon-reference/         a complete implementation, committed
  polygon-acceptance/        the hidden suite, committed, never given to the agent
```

`polygon-reference/` is how we know the hidden suite is passable at all. A suite
nobody has ever seen go green is not ground truth, it is a guess — and a study
whose ceiling is unreachable spends $100 to measure nothing.

Commands:

```bash
node plugins/p-tasks/scripts/measure-tracker.mjs --pilot
node plugins/p-tasks/scripts/measure-tracker.mjs --arm none
node plugins/p-tasks/scripts/measure-tracker.mjs --arm ptasks
node plugins/p-tasks/scripts/measure-tracker.mjs --arm beads
node plugins/p-tasks/scripts/measure-tracker.mjs --score
```

There is no `--only` flag. A finished run is one that has rows in `runs.jsonl`,
so re-running part of the study is: delete those rows, run `--arm <name>` again.
The harness picks up exactly what is missing.

## 12. Preflight

The `beads` arm refuses to start unless `bd` is on PATH and `bd init` works in a
scratch directory. It fails **before the first dollar is spent**, the way
p-graph's LSP arm does. A half-installed rival that answers nothing would show
up as "beads lost", when what lost was the setup.

Then one **smoke session per arm** — a single real session, checked only for
exiting cleanly and leaving the tracker in a readable state. About $1.50 for all
three, against a full arm's worth of runs wasted on a rule file that turned out
to be in the wrong place.

`bd setup claude` also installs hooks into the project's own
`.claude/settings.json`, while the harness passes its own file through
`--settings`. Both apply. The smoke session is what proves those two do not
fight before 50 sessions are spent finding out.

## 13. Risks

| Risk | What we do |
|---|---|
| All three arms finish everything — no difference to see | the pilot's 40–90% band exists to catch this before the full spend |
| `none` is not much worse | then that is the answer, and it gets published as it stands. It is the cheapest possible outcome to act on |
| A wrong hidden test reads as a regression | every test cites a requirement; no clock, no network, no randomness |
| The rival needs a build environment we do not have | preflight, before any spend |
| Feature work varies too much to read | five runs a side, and every table reports the spread, not only the mean |

## 14. What this study may and may not claim

Two limits have to be written next to the numbers, not discovered by a reader
later.

**`p-tasks` against `beads` is a clean comparison.** Both arms get a rule and a
place to store items. The only difference is the product. Whatever gap shows up
belongs to the product, and the migration decision rests on it.

**`tracker` against `none` is a coarse comparison.** The `none` arm has no
`CLAUDE.md` at all, so it is missing not only the storage but also the rule
text, and those rules say generic useful things — plan first, do one item at a
time. Part of any gap is therefore the advice, not the tracker. The study can
say "installing a tracker helps"; it cannot split that into "the storage helped"
and "the advice helped". Splitting it would need a fourth arm with advice and no
storage, which is a product nobody ships.

**The model is `sonnet`, the user's real work runs on Opus.** Sonnet is chosen
because 150 sessions on Opus is a different budget. A stronger model forgets
less between sessions, so if anything this setup **flatters** the trackers. A
result of "the tracker barely helps" would hold on Opus too; a result of "the
tracker helps a lot" is measured on Sonnet and says so.
