# Spec audit subagent — design

Date: 2026-07-02
Status: approved (pending spec review)
Plugin: `p-flow`

## Problem

`task-brainstorming` produces the feature spec (`specs/<slug>/specification.md`, optionally
`feature.feature` and `adr.md`). Its current §5 "Self-review" is a shallow inline scan by the
same agent that just authored the spec — it looks for leftover placeholders, contradictions,
ambiguity, and scope creep, then fixes inline. Because it runs in the authoring context, it
inherits the author's blind spots and rarely surfaces genuine logical errors or cross-file
inconsistencies.

We want a **thorough, fresh-context** audit after the spec is written: a separate subagent that
hunts logical errors and inconsistencies and **fixes them**, looping until no critical issues
remain, and asking the user when a fix requires a decision it must not guess.

## Decision summary

| Question | Decision |
|---|---|
| Where does it live? | Replace `task-brainstorming` §5 with a subagent audit-fix loop. No new skill. |
| Fix model | The subagent **edits the spec files itself** (read-write). This deliberately overrides p-flow's "reviews are read-only" invariant — **for specs only** (cheap, reversible, and the human still reviews the final at §6). |
| Loop | Loop-until-clean, driven by **Blockers only**. Subagent fixes all severities per pass, but the loop repeats only while Blockers remain. |
| Loop cap | **3 passes.** After the 3rd pass, any remaining Blockers are handed to the user at §6 as an explicit list — never an infinite loop. |
| User questions | The subagent never guesses on genuine ambiguity / missing information. It returns questions; the main agent relays them to the user (one at a time), then re-dispatches with the answers. |
| Dispatch mechanism | `Task` tool + `subagent_type: general-purpose` + a colocated inline template `spec-auditor.md`. This is the Wave A pattern already used by `code-reviewer.md` / `task-reviewer.md`. |
| Scope | Only full specs authored by `task-brainstorming`. `/p-flow:init` Phase 2 stub specs (intentionally full of `{{PLACEHOLDERS}}`) are **not** audited. |
| Automatic? | Yes — runs automatically as part of the phase, not gated behind an offer. |

## Severity model

Reuses p-flow's existing 3-severity model (see `plugins/p-flow/CLAUDE.md` § Severity model):

- **Blocker** — a logical error, internal contradiction, cross-file inconsistency, unreachable or
  contradictory scenario, or an acceptance criterion that is missing / self-contradictory. Must be
  resolved before the spec is considered clean. **Drives the loop.**
- **Suggestion** — a clarity or completeness improvement. Fixed in-pass when unambiguous; does not
  drive the loop.
- **Nit** — cosmetic. Fixed in-pass; does not drive the loop.

## What the auditor checks

Given a fresh read of every file in `specs/<slug>/` (`specification.md`, and `feature.feature` /
`adr.md` when present):

- **Logical errors** — requirements that cannot all hold at once; acceptance criteria that
  contradict the happy path or each other.
- **Internal contradictions** — a statement in one section negated by another.
- **Cross-file inconsistencies** — `specification.md` ↔ `feature.feature` ↔ `adr.md` disagree
  (e.g. a scenario in `feature.feature` with no matching requirement, an ADR decision the spec
  contradicts).
- **Ambiguous requirements** — a requirement readable two different ways. If the auditor can pick
  the intended reading from surrounding context, it fixes it; otherwise it becomes a **user
  question**, not a guess.
- **Coverage gaps** — a stated behavior with no acceptance criterion; an error/edge case named in
  prose but absent from scenarios.
- **Scope creep** — requirements drifting into adjacent work not in this task's problem statement.

It does **not** design new behavior, add features, or make product decisions — those are user
questions.

## Flow (task-brainstorming §5, replacing the inline self-review)

```
§4 Materialization  →  §5 Spec audit (subagent loop)  →  §6 User review gate
```

Loop, `pass = 1..3`:

1. Dispatch the auditor subagent (`Task` + `general-purpose`, prompt = `spec-auditor.md` inlined +
   the `specs/<slug>/` file paths + any accumulated user answers from prior passes).
2. Subagent reads all spec files, fixes everything it can unambiguously fix, and returns a
   structured result:
   - `fixed` — list of edits applied (file + one-line what/why).
   - `blockers_remaining` — Blockers it could **not** fix without a user decision.
   - `questions` — questions the user must answer to resolve a Blocker (each tied to a Blocker).
3. Main agent:
   - If `questions` is non-empty → ask the user **one at a time** (brainstorming style), collect
     answers, and carry them into the next pass's dispatch. `pass` does **not** advance on a
     pure question round — re-dispatch with answers so the subagent can apply the resolution.
   - Else if `blockers_remaining` is empty → **clean**, exit loop, go to §6.
   - Else → advance `pass`, re-dispatch (fresh audit catches regressions introduced by fixes).
4. After `pass == 3`, if Blockers still remain, stop looping and carry the remaining list into §6
   so the user sees them explicitly.

At §6 the main agent shows a consolidated summary of everything the subagent changed across all
passes, plus any Blockers left unresolved after the cap.

## Files touched

| File | Change |
|---|---|
| `skills/task-brainstorming/SKILL.md` | Rewrite §5 from "inline self-review" to "Spec audit (subagent loop)"; reference `${CLAUDE_SKILL_DIR}/spec-auditor.md`; document the 3-pass cap, Blockers-drive-the-loop rule, and the user-question escape hatch. Update the §6 wording to mention the change summary + any capped-out Blockers. Add `Task` to `allowed-tools`. Keep the hard gate: no `writing-plan` before user approval at §6. |
| `skills/task-brainstorming/spec-auditor.md` (new) | Colocated inline auditor template. Read-write. Contains a `## What is NOT your scope` section (structural invariant enforced by `tests/review-template-refs.test.ts`). Defines the checks above, the 3-severity output, the "fix don't guess; escalate genuine ambiguity as a question" rule, and the exact structured return shape (`fixed` / `blockers_remaining` / `questions`). |
| `plugins/p-flow/README.md` | Note the audit step under `task-brainstorming` if the Skills table describes phase behavior. Add `spec-auditor.md` to the Reviewer templates note if that section enumerates templates. |
| `plugins/p-flow/CLAUDE.md` | Add an architecture-decision row: spec audit is the **one** sanctioned read-write "review" (specs only), with rationale. Note `spec-auditor.md` is read-write, unlike `code-reviewer.md` / `task-reviewer.md`. |
| `plugins/p-flow/.claude-plugin/plugin.json` | Minor version bump (additive behavior). |
| `plugins/p-flow/RELEASE-NOTES.md` | New `## v<x.y.z>` section. |

## Tests

- `tests/review-template-refs.test.ts` — extend so `spec-auditor.md` is covered: file exists and
  contains `## What is NOT your scope`. (The existing test enumerates reviewer templates; add this
  one.)
- Consistency check that `task-brainstorming/SKILL.md` references `spec-auditor.md` and that §5
  documents the 3-pass cap. Fold into the cross-skill consistency test or a small new assertion.
- No behavioral test can assert the subagent's audit quality (same limitation as the existing
  reviewers — documented as manual smoke-test).

## Rationale for overriding "reviews are read-only"

p-flow keeps code/plan reviewers read-only because auto-editing code before a human sees it is
risky and findings deserve explicit triage. Specs are different: they are prose, cheap to
regenerate, and always pass through the §6 human review gate before any code is written. Letting
the auditor fix directly removes a slow report→triage→apply round-trip for issues that are almost
always mechanical (contradictions, missing criteria, cross-file drift), while genuine judgment
calls still stop and ask the user. The read-only invariant stays intact for code and plans.

## Out of scope

- Auditing `/p-flow:init` Phase 2 stub specs.
- Auditing code, plans, or `plan.md` / p-tasks sub-tasks.
- Turning the auditor into a general-purpose spec generator — it audits and fixes an existing spec,
  it does not author new behavior.
- Making the audit optional / gated — it is an automatic phase step.
```

