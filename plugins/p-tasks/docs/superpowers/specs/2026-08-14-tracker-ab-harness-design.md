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

A small but real JavaScript project, about 500–800 lines, with vitest already
set up. We write it once and freeze it as a seed commit.

It ships a `SPEC.md` describing one feature as about ten requirements with real
dependencies between them — for example: load a config file → validate it →
map CLI flags onto it → error messages → JSON output → exit codes. Later
requirements cannot be finished before earlier ones, so a tracker's blocker
graph has something true to hold.

The seed also has a small **visible** test suite, so the agent can check itself.
The score does not come from it.

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
               --model sonnet --max-budget-usd 2
        copy the working tree to snapshots/<arm>-<run>/s<NN>/
        run the hidden suite against that copy
        append one line to runs.jsonl
        stop early if every hidden test is green
```

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
| **Regressions** | a test green in session *k* and red in *k+1* | lost memory — the metric this study exists for |
| Churn | sum of the diffs between neighbouring snapshots, divided by the diff between the seed and the last snapshot | work done twice |
| Cost | sum of `cost_usd` over the run | price |
| Tracker tax | token counts per session from the CLI's `usage` field; the gap between arms is the tax. If the CLI does not return `usage`, cost per session stands in for it | what the rule and the tool output cost every session |

Churn of 1.0 means every line was written once. Churn of 3.0 means the same
lines were rewritten three times over.

This is a real improvement on the p-graph harness: there, a second model had to
read each answer and extract the claims. Here the score is a vitest JSON report.
It is free, exact, and identical every time.

## 8. Not disturbing the p-graph measurement

A p-graph measurement may be running at the same time. The harness therefore:

- uses its own work directory, `%TEMP%\ptasks-measure`, never `pgraph-measure`
- uses its own settings file, `ptasks-arm-settings.json`
- runs sessions strictly one at a time, so it does not fight the other study for
  API rate limits
- lives in the `tracker-ab` git worktree

## 9. Pilot first

Before spending the full budget: one arm (`ptasks`), one run, ten sessions —
about $5.

The pilot passes if the hidden suite ends between **40% and 90% green**. Below
40%, the feature is too big; cut requirements. Above 90%, it is too easy and
every arm will tie at the ceiling; add requirements. Only a calibrated polygon
can show a difference between arms.

## 10. Cost

| | Sessions | Expected | Hard ceiling |
|---|---|---|---|
| Pilot | 10 | ~$5 | $20 |
| Full study | 3 arms × 5 runs × 10 sessions = 150 | $60–100 | $300 |

The ceiling is the per-session cap ($2) times the session count. It is what the
study can cost if every single session runs to its cap, which is not what we
expect.

The harness also takes `--max-total-usd`, default **150**. That is a brake, not
a budget: if the study passes $150 while the estimate was $60–100, something is
wrong and a human should look before more money goes out. Raise the flag to
carry on.

Five runs a side, not three. p-graph's README already records that three runs a
side is too few to read its accuracy rows closely, and feature work varies more
than answering a question.

## 11. Files

```
plugins/p-tasks/scripts/
  measure-tracker.mjs        the harness
  beads-arm-rule.md          the rule text the beads arm writes to CLAUDE.md
  polygon/                   the seed project, committed
    SPEC.md                  the feature, ~10 requirements
    package.json src/ tests/ the visible suite
  polygon-acceptance/        the hidden suite, committed, never copied to the agent
```

Commands:

```bash
node plugins/p-tasks/scripts/measure-tracker.mjs --pilot
node plugins/p-tasks/scripts/measure-tracker.mjs --arm none
node plugins/p-tasks/scripts/measure-tracker.mjs --arm ptasks
node plugins/p-tasks/scripts/measure-tracker.mjs --arm beads
node plugins/p-tasks/scripts/measure-tracker.mjs --score
```

`--only <arm>-<run>` re-runs part of it after those rows are deleted, matching
p-graph's `--only`.

## 12. Preflight

The `beads` arm refuses to start unless `bd` is on PATH and `bd init` works in a
scratch directory. It fails **before the first dollar is spent**, the way
p-graph's LSP arm does. A half-installed rival that answers nothing would show
up as "beads lost", when what lost was the setup.

## 13. Risks

| Risk | What we do |
|---|---|
| All three arms finish everything — no difference to see | the pilot's 40–90% band exists to catch this before the full spend |
| `none` is not much worse | then that is the answer, and it gets published as it stands. It is the cheapest possible outcome to act on |
| A wrong hidden test reads as a regression | every test cites a requirement; no clock, no network, no randomness |
| The rival needs a build environment we do not have | preflight, before any spend |
| Feature work varies too much to read | five runs a side, and every table reports the spread, not only the mean |
