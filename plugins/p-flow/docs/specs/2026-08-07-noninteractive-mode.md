# Non-interactive mode for `requesting-code-review`

**Date:** 2026-08-07 · **Wave:** K · **Plugin:** p-flow 1.10.0

## Problem

`requesting-code-review` cannot run in a headless `claude -p` job. Two places require a human, and
both are load-bearing rather than incidental:

1. **Preconditions item 3** — requires `specs/<slug>/specification.md` to exist, and derives
   `<slug>` from the branch name *"or ask the user"*.
2. **§4 Triage protocol** — *"Blockers: one at a time. For each, ask the user with three options:
   fix / defer / reject"*, explicitly *"No defaults — user must answer"*, plus a Suggestions batch
   question and a Nits question.

A p-shed worker job runs `claude -p` with no user and no `specs/<slug>/specification.md` — p-tasks
is the canonical store in that deployment. The cost is measured, not assumed: across 502 worker
sessions the skill was invoked 4 times, and the worker hand-rolls its own review dispatch instead.
`subagent-driven-development` calls this skill's `code-reviewer.md` for its final broad review, so
the same wall blocks SDD headless.

## Approach

An **env-var gate in a shared doc**, following the `_shared/ptasks-bridge.md` precedent exactly —
including its rule that the untouched path stays byte-for-byte unchanged.

```
                    test "${P_FLOW_NONINTERACTIVE:-}" = "1"
                                   │
              exit 1 ──────────────┴──────────────── exit 0
      (unset / empty / 0 / true /                      │
       any other value)                                │
              │                             ptasks gate (docs/tasks/.ptasks.json)
              ▼                                  │                    │
      INTERACTIVE                          absent│                    │present
      today's path,                              ▼                    ▼
      byte-for-byte                        STOP, named          jira destination
      unchanged; the                       reason                  │        │
      gate is a silent                                        yes  │        │ no
      no-op                                                        ▼        ▼
                                                            STOP, named   NON-INTERACTIVE
                                                            reason        fixed policy
```

The shared doc supplies **the gate and the rule**. Each host skill supplies **its own defaults**,
written next to the question they replace. A default invented at runtime is not a default.

**The rule.** In non-interactive mode a skill never asks. At every point where the interactive path
would put a question, it either applies the documented default or fails loudly with a named reason.
It must never invent an answer on the user's behalf on a question that is the user's to decide —
accepting, deferring, or ordering work can be defaulted; a judgement that a finding is *wrong*, or
a consent to an external irreversible write, cannot.

## The two defaults

| | Interactive (unchanged) | Non-interactive |
|---|---|---|
| **Precondition 3** | `specs/<slug>/specification.md` must exist; `<slug>` from the branch **or ask the user** | requirement dropped; `<slug>` = the parent p-tasks task title, which the bridge defines as being exactly the slug, confirmed via `p-tasks:list <slug>`; **Goal** composed from that task's `--description` |
| **Blockers** | one at a time, `fix` / `defer` / `reject`, no defaults | all → `fix` |
| **Suggestions** | numbered list, reply with indices | all → `fix` |
| **Nits** | numbered list; default `reject all`, reason *nit declined* | all → **`defer`**, reason *nit declined (non-interactive default)* |
| **`reject`** | available | **unavailable** |

`fix` means what it means interactively: the finding becomes a follow-up work item recorded by §5.
The skill still fixes nothing itself — `receiving-code-review` picks the sub-tasks up.

## Decisions

**Nits defer rather than reject.** The interactive default for a Nit is `reject all`, which the new
rule forbids. Deferring preserves the interactive default's *intent* — a nit does not become work —
while honouring "rejecting is a human judgement". It also keeps the audit entry structurally
identical: a done `code-review:nit` sub-task carrying a `--resolution`, exactly as a human's defer
produces. Filing nits as open follow-ups was rejected: a headless loop would dutifully implement
cosmetic work. Dropping them silently was rejected: a finding would vanish with no trace.

**Headless requires canonical mode.** If p-tasks is absent the run stops with a named reason even
when `specification.md` and `plan.md` both happen to exist. One documented headless path, one set
of defaults, one test surface — and it matches the actual target, where p-tasks *is* the canonical
store. Legacy interactive behaviour is untouched.

**A `jira` destination stops the run, and stops it early.** The bridge requires an explicit yes
before creating real issues; there is nobody to give it, and consent to an external irreversible
write is not defaultable. The check sits in precondition 3, before the reviewer is dispatched, so a
headless run does not burn a review it could not record.

**`allowed-tools` gains `Bash(test:*)` and `Skill`.** `test` is the gate probe; `Skill` is the
p-tasks dispatch. `Skill` closes a **pre-existing gap** — §5 canonical mode already dispatched
`p-tasks:add` without declaring it. The headless path makes it mandatory rather than incidental.
Widening `allowed-tools` cannot change interactive output.

## Not touched

`code-reviewer.md` — the reviewer template is language- and mode-neutral and is reused by
`subagent-driven-development`. No other skill. No interactive code path. No plugin dependency.

## Verification

`tests/p-flow-noninteractive.test.ts` (12 assertions) defends: the shared doc exists and pins the
env var, its strict `= "1"` value, the silent/byte-for-byte interactive default and the never-invent
rule; the skill references it; the interactive three-option Blocker question and the Suggestions
batch question survive **verbatim**; the non-interactive triage block contains no question mark, no
"ask the user", and makes `reject` unavailable; the headless failure paths are named; `allowed-tools`
covers the new path; `code-reviewer.md` stays mode-neutral.

`p-flow-cross-skill-consistency.test.ts` and `p-flow-sdd-decoupling.test.ts` both reference this
skill and stay green.
