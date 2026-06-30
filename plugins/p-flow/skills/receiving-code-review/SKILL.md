---
name: receiving-code-review
description: Use when processing review feedback — a `## Review follow-ups` item in plan.md, a PR comment, an inline reviewer message. Enforces verify-the-finding-first discipline before implementing or rejecting. Counterpart to requesting-code-review.
allowed-tools: Bash Read Glob Grep Edit Write
---

# receiving-code-review

Treat every review finding as a hypothesis, not a directive. For each one — verify it's correct, decide whether to fix or push back with evidence, then act.

**Announce at start:** *"I'm using the `receiving-code-review` skill to process the review findings rigorously — verify first, then fix or reject with evidence."*

## When to use

- Working through a review follow-up created by `requesting-*-review` (the primary path). Run the p-tasks gate in `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md` to know where it lives:
  - **Legacy mode** (p-tasks absent) → a `## Review follow-ups — <date>` item in `specs/<slug>/plan.md`.
  - **Canonical mode** (p-tasks present) → a sub-task of the `<slug>` task with `origin` = `code-review:*` / `task-review:*` (enumerate with `p-tasks:list <parent>` via the Skill tool and filter by `origin`).
- A PR comment / inline review message lands and you're about to respond or implement.
- A subagent (or a human reviewer) returns findings and you need to action them.

## Inputs

- The finding itself (text + file:line citation if available).
- The code being reviewed.
- Optional — the spec / plan that motivated the change.

## Procedure

### 1. Verify the finding is correct

For each finding, ask:

- **Does the cited file:line actually contain what the finding describes?** Open it. Read it. If the citation is stale or wrong, the finding may be too.
- **Is the issue real given the actual behaviour of the code?** Run the relevant test. Check the actual flow. Don't take the reviewer's word for runtime behaviour.
- **Does the suggested fix actually address the issue?** Sometimes a finding identifies a real symptom but proposes a wrong fix.

### 2. Classify

- **Valid + fix recommended.** Apply the fix.
- **Valid + alternative fix is better.** Propose the alternative; reply to the reviewer explaining the reasoning.
- **Invalid (false positive).** Reject with a one-line evidence-based reason. Don't argue tone, argue facts.
- **Unclear / can't reproduce.** Ask the reviewer for repro steps or a more specific citation. Don't guess.

### 3. Act per the classification

**Fixing** a finding:
- Apply the fix.
- Run the relevant test (or write one if missing) to confirm the fix works AND nothing regresses.
- Quote the test pass in your response.
- **Mark it done.** Legacy mode → check the `## Review follow-ups` item `[x]` in plan.md. Canonical mode → via the Skill tool, `p-tasks:set <st-id> --status done` for the follow-up sub-task.

**Rejecting** a finding:
- **Legacy mode** — a `## Review follow-ups` item in plan.md → mark the parent step `[x]` AND append a one-line `> Rejected — <evidence-based reason>` immediately below the step. Do NOT add a separate entry to `## Review decisions (audit)` — that section already records the original triage decision from `requesting-code-review`; rejecting on second look is a re-decision, annotated inline at the follow-up.
- **Canonical mode** — the follow-up is a sub-task → via the Skill tool, `p-tasks:set <st-id> --status done --resolution "<evidence-based reason>"`. The `resolution` field records the re-decision (it replaces the inline `> Rejected —` annotation); don't write to plan.md.
- If it's a PR comment / external review → reply with the evidence-based reason. Don't touch plan.md or p-tasks.

**Deferring** a finding (rare — usually means we can't decide yet):
- Add a `## Review decisions (audit)` bullet using the same format `requesting-code-review` uses — but prefixed `receiving:` so the source is traceable.

## Hard rules

- **Never blindly fix.** Every fix must be preceded by verification that the issue is real.
- **Never silently reject.** Every rejection must be explicit and recorded (inline annotation in plan.md, or written reply for external reviews).
- **Never argue tone, argue facts.** "This is wrong" is not feedback; show evidence (file:line, test output, spec citation).
- **Reviewer might be wrong.** Both `code-reviewer` and `task-reviewer` templates have ~20% scope leakage on Sonnet (see `plugins/p-flow/README.md` "Known limitations"). Read findings critically.

## Red flags — STOP

- "I'll just fix all the suggestions to be safe." No — blind fixes degrade the code.
- "The reviewer says X, so it must be X." Verify it first.
- "I disagree but I'll fix it to avoid argument." No — explain the disagreement with evidence; let the reviewer correct your reasoning if you're wrong.

## What this skill does NOT do

- Does not dispatch a reviewer — that's `requesting-code-review` / `requesting-task-review`.
- Does not modify the reviewer prompt templates — those are colocated with the requesting skills.
- Does not auto-close PR threads.
- Does not change `## Review decisions (audit)` entries written by `requesting-*-review` — those are the historical record of the original triage.
