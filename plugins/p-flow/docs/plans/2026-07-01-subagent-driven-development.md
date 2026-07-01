# p-flow — `subagent-driven-development` skill (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `p-flow:executing-plan` to implement this plan step by step (TDD per code step, verify after each). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a `subagent-driven-development` skill to p-flow: an in-session execution loop that dispatches a fresh implementer subagent per plan step, runs a per-task review (spec compliance + code quality) after each, and a broad whole-branch review at the end — keeping the controller's context clean by handing artifacts over as files. It complements the existing inline `executing-plan`; the user chooses per task which to use. Zero coupling to any external plugin.

**Why:** `executing-plan` runs every step inline in the main session — implementation detail pollutes the controller's context and there is no per-step isolation. A subagent-per-task loop gives fresh context per step, automatic review checkpoints, and continuous execution, at the cost of more subagent invocations. This is the single most valuable execution pattern p-flow still lacks.

## References

- `skills/executing-plan/SKILL.md` — the inline sibling; SDD is the isolated alternative. The two share the p-tasks gate and the "mark done only on green" rule.
- `skills/requesting-code-review/{SKILL.md,code-reviewer.md}` — the dispatch pattern (`Task` + `general-purpose` + inline template) and the reused final-review template.
- `skills/_shared/ptasks-bridge.md` — the progress ledger when p-tasks is present; plan.md `## Steps` when absent.
- `skills/writing-plan/SKILL.md` — produces the step list SDD executes; its hand-off must offer SDD as an alternative to `executing-plan`.

## Non-goals

- **No parallel-session variant.** SDD is same-session only. A separate parallel-session executor is out of scope.
- **No bash helper scripts.** File handoffs use bare `git` + `Write` so the skill works on Windows without a Git-Bash dependency.
- **No registered subagents.** Reviewers/implementers are dispatched via `Task` with `subagent_type: general-purpose` + inline template content (the Wave A pattern).
- **No change to `executing-plan`.** Its inline behaviour stays byte-for-byte.

## Design decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Dispatch is always `Task` + `general-purpose` + inline template content | Works in any session without a plugin install; matches the reviewer-dispatch pattern already in p-flow. |
| 2 | Progress ledger = p-tasks sub-tasks (canonical) or plan.md `## Steps` checkboxes (legacy), gated by `_shared/ptasks-bridge.md` | p-flow already has a canonical step store; reuse it instead of inventing a separate ledger file. Free compaction-recovery. |
| 3 | Handoff artifacts live under `.p-flow/sdd/` with a self-ignoring `.gitignore` | Keeps briefs/diffs/reports out of the controller's context and out of `git status`. Decoupled namespace (never `.superpowers/`). |
| 4 | Final whole-branch review reuses `../requesting-code-review/code-reviewer.md` | One canonical code-review template; no duplication. |
| 5 | Per-task reviewer emits `Blockers / Suggestions / Nits` + a spec-compliance verdict | Same severity model as the rest of p-flow, so triage is consistent. |
| 6 | Every dispatch specifies `model` explicitly | Cost/speed control; an omitted model silently inherits the session's most expensive one. |
| 7 | The implementer follows `test-driven-development` inside its own turn | TDD discipline is enforced where the code is actually written, not in the controller. |

## Global constraints

- No string `superpowers` and no `.superpowers/` path anywhere in the shipped skill or its templates.
- The controller NEVER pastes a plan step's full text or a diff into a dispatch prompt — it hands them over as files under `.p-flow/sdd/`.
- Mark a step done ONLY after the per-task review returns spec ✅ and no open Blockers.
- Dispatch implementers one at a time (no parallel implementers — they would conflict).

## Steps

1. [ ] **Scaffold the skill directory + frontmatter.**
   - **Files**: `skills/subagent-driven-development/SKILL.md`
   - **Acceptance**: SKILL.md has valid frontmatter (`name: subagent-driven-development` matching the dir, `description` ≥ 30 chars, parseable `allowed-tools` including `Task` and `Skill`), an `**Announce at start:**` line, and body > 100 chars. `tests/skills.test.ts` passes for it.

2. [ ] **Write the controller procedure body.**
   - **Files**: `skills/subagent-driven-development/SKILL.md`
   - **Acceptance**: Body has the p-flow section order (`## When to use` incl. "Don't use when → executing-plan for inline", `## Inputs`, `## Mode` running the p-tasks gate, `## Procedure` per-step loop, `## Model selection`, `## Handling implementer status`, `## Hard rules`, `## Red flags — STOP`, `## What this skill does NOT do`). References `_shared/ptasks-bridge.md`, dispatches `general-purpose`, reuses `../requesting-code-review/code-reviewer.md` for the final review, hands off to `task-end`.

3. [ ] **Write the implementer prompt template.**
   - **Files**: `skills/subagent-driven-development/implementer-prompt.md`
   - **Acceptance**: Template covers ask-questions-first, TDD, self-review, report-to-file, and the 4 statuses (`DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`). No `superpowers` string.

4. [ ] **Write the task-reviewer prompt template.**
   - **Files**: `skills/subagent-driven-development/task-reviewer-prompt.md`
   - **Acceptance**: Template has "don't trust the report", Part 1 spec compliance (Missing/Extra/Misunderstood + ⚠️ cannot-verify), Part 2 code quality, output format with `### Blockers / ### Suggestions / ### Nits` + a spec verdict. Contains a `## What is NOT your scope` section. No `superpowers` string.

5. [ ] **Update `writing-plan` hand-off to offer SDD.**
   - **Files**: `skills/writing-plan/SKILL.md`
   - **Acceptance**: Step 8 offers a choice between `executing-plan` (inline, same context) and `subagent-driven-development` (fresh subagent per step, isolated), invoking the chosen one via the Skill tool.

6. [ ] **Register the skill in discovery + docs.**
   - **Files**: `skills/using-p-flow/SKILL.md`, `README.md`, `.claude-plugin/plugin.json`, `CLAUDE.md`, `RELEASE-NOTES.md`
   - **Acceptance**: New skill appears in the `using-p-flow` skills table and the README Skills table (so `plugin-readme-coverage.test.ts` passes), `plugin.json` version bumped minor (1.3.0 → 1.4.0) with the description enumerating the new skill, CLAUDE.md "What lives where" tree + architecture note + test-invariants row updated, RELEASE-NOTES has a new section.

7. [ ] **Add the decoupling/structure test.**
   - **Files**: `tests/p-flow-sdd-decoupling.test.ts`
   - **Acceptance**: Asserts the 3 skill files exist, contain no `superpowers`/`.superpowers/`, dispatch via `general-purpose`, route the ledger through `_shared/ptasks-bridge.md`, and reuse the canonical `code-reviewer.md`. Full suite green.

## Tests

- Auto-coverage: `tests/skills.test.ts` (frontmatter/body), `tests/plugin-readme-coverage.test.ts` (README mention).
- New: `tests/p-flow-sdd-decoupling.test.ts` (Step 7).
- Existing bridge tests (`p-flow-ptasks-bridge.test.ts`) still pass — no new manifest dependency, no CLI call.

## Risks

- **Cost.** Implementer + reviewer per step multiplies subagent invocations. Mitigation: the Model selection section pins the cheapest adequate model per role.
- **Windows file handoffs.** Bare-git redirection (`git diff … > file`) runs through the Bash tool; if a repo has no Git-Bash the controller falls back to running `git diff` and `Write`-ing the output. Documented in the skill.
- **p-tasks-as-ledger.** Relies on the no-status-cascade property already pinned by `p-flow-ptasks-recipe.test.ts`; closing sub-tasks stays explicit.

## Open questions

- Whether to later factor the file-handoff mechanics into `_shared/` so `executing-plan` can borrow them. Deferred — SDD is the only consumer today.
