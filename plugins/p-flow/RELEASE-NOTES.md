# p-flow Release Notes

> Marketplace tag → p-flow plugin version → date → headline.
> Authored 2026-05-27; backfilled from `v4.6.0` onward (the first p-flow release on the marketplace was `v3.1.0` with `plugins/p-flow 0.1.0` — a minimal `init` skill; see `git log v4.5.0..v4.6.0 -- plugins/p-flow/`).

## v4.13.0 — `plugins/p-flow 0.7.0` — 2026-06-04 — `/p-flow:init` Phase 2 brainstorm

- `/p-flow:init` now runs in two phases. Phase 1 is the existing scaffolding (rules + templates + settings merge). Phase 2 is a new repo-level brainstorm dialog that captures vision / problem / users / out-of-scope and identifies an initial feature list, then materialises one stub `specs/<slug>/specification.md` per agreed feature.
- Each stub is the standard `specification.template.md` with metadata + problem + user story + 1–3 acceptance bullets filled. Deeper sections stay as `{{PLACEHOLDERS}}` and are resumed later by `task-brainstorming`'s refine-mode when the user runs `/p-flow:task-start feature/<slug>`.
- State-machine guard on entry replaces the previous unconditional refuse:
  - rules missing + specs empty → run both phases (greenfield).
  - rules present + specs empty → skip Phase 1, run Phase 2 only (resume interrupted dialog).
  - specs has ≥ 1 folder → refuse (use `/p-flow:task-start` for new features).
  - rules missing + specs present → refuse (inconsistent state; user resolves).
- Phase 2 is skippable via `AskUserQuestion` for users who prefer to add features ad-hoc.
- **No new skill, no `specs/repo.md`, no roadmap file.** Folders remain the canonical source of truth. Adding / refining / dropping features later uses the existing `task-start` + `task-brainstorming` workflow (drop = user manually sets `Status: dropped` in the spec frontmatter).
- **No breaking changes.** Existing initialised repos are protected by the state-machine guard's "refuse if specs exist" rule — no risk of overwriting stubs or specs.
- New regression test file `tests/p-flow-init-phase2.test.ts` — guards the state-machine table shape, the `grep -q .` detection (vs the broken `head -1`), the cross-file consistency between SKILL.md and README's Idempotency table, and Step 9 placeholder ↔ template name agreement.

## v4.10.0 — `plugins/p-flow 0.6.0` — 2026-05-27 — Wave D (cleanup batch)

- New skill `using-git-worktrees` — reference documentation for safe worktree creation, common pitfalls, cleanup.
- New skill `writing-skills` — meta-skill documenting p-flow's authoring conventions (frontmatter, section order, dispatch patterns, template placement, test coverage).
- New file `plugins/p-flow/RELEASE-NOTES.md` (this file).
- New file `plugins/p-flow/CLAUDE.md` — contributor guide for the plugin.
- `skills/task-end/SKILL.md` adds a `## Design note` defending the deliberate narrowing (no merge/PR/cleanup menu).
- `skills/task-start/SKILL.md` gains a `digraph` flow diagram visualizing Phase A → Phase B branching.
- All 12 invoke-able skill bodies prepend an `**Announce at start:**` line (matches superpowers' convention; `using-p-flow` excluded — auto-emitted, not invoked).
- 3 skills' `allowed-tools` tightened: `task-brainstorming` drops `Glob` + `Bash(git rev-parse:*)`; `writing-plan` drops `Glob`; `verification-before-completion` drops `Glob` + `Grep`. No behavioural change.
- **Explicitly NOT in this wave:** `Agent → Task` terminology rename (cosmetic, both names work in CC), retrofit Graphviz to all 6+ skills (only `task-start` benefits enough), new `dispatching-parallel-agents` skill (YAGNI — review skills work sequentially).

## v4.9.0 — `plugins/p-flow 0.5.0` — 2026-05-27 — Wave C (TDD + receiving-code-review)

- New skill `test-driven-development` — RED-GREEN-REFACTOR enforcement before writing production code. Pairs with `verification-before-completion` ("before code" gate vs "before claiming done" gate).
- New skill `receiving-code-review` — verify-the-finding-first discipline when processing review feedback (plan.md `## Review follow-ups` items, PR comments, reviewer replies). Counterpart to `requesting-code-review`.
- `skills/writing-plan/SKILL.md` now offers two plan template variants from `_shared/templates/`:
  - `plan-tdd.template.md` — TDD-aligned (default for code tasks). Each Step has `Test first` (RED) / `Implement` (GREEN) / `Verify` (REFACTOR-safe) sub-instructions.
  - `plan-generic.template.md` — for docs/research tasks.
- Detection is heuristic (suggests TDD if `feature.feature` exists or AC mentions code behaviors); user explicitly confirms before writing.
- Templates are skill-internal (not copied into user repo by `/p-flow:init`). Plan template's single-checkbox-per-Step shape preserves `task-end` completeness-counter semantics.
- **Backwards-compatible.** Existing `plan.md` files unchanged. `/p-flow:init` unchanged (still copies 4 templates, not the 2 new plan templates).

## v4.8.0 — `plugins/p-flow 0.4.0` — 2026-05-27 — Wave B (discovery skill + SessionStart hook)

- New skill `using-p-flow` — discovery skill that lists all p-flow commands + skills + hard rules. Auto-surfaced via SessionStart hook.
- New `plugins/p-flow/hooks/` — `hooks.json` wires the `SessionStart` event with matcher `startup|clear|compact`. `session-start` (bash) reads `using-p-flow/SKILL.md`, JSON-escapes it, emits a `<system-reminder>` envelope. `run-hook.cmd` is a cross-platform polyglot wrapper (Unix + Windows) modeled on superpowers' approach; silent no-op on Windows when Git-Bash is absent.
- Plugin README documents the discovery + hook surface.
- Closes audit gaps B2 + A-11.

## v4.7.0 — `plugins/p-flow 0.3.0` — 2026-05-27 — Wave A (agents → inline templates)

- **BREAKING for any external caller of `Task (p-flow:code-reviewer)` / `Task (p-flow:task-reviewer)`** — those registered subagents no longer exist. Switch to `Task (general-purpose)` + inline the template from `skills/requesting-*-review/<reviewer>.md`.
- Reviewers migrated from plugin-level `agents/<name>.md` (registered subagents) to `skills/requesting-*-review/<reviewer>.md` (inline templates dispatched via `Task` tool with `general-purpose`). Mirrors superpowers' post-v5.1.0 pattern.
- Portability fix: reviewers now work in any Claude Code session without requiring p-flow plugin install at the target.
- `tests/agents.test.ts` + `tests/subagent-refs.test.ts` retired; `tests/review-template-refs.test.ts` replaces them with the new invariants (template exists + `## What is NOT your scope` section present).
- Plugin README's `## Subagents` section replaced by `## Reviewer templates`.

## v4.6.5 — `plugins/p-flow 0.2.0` — 2026-05-27 — superpowers parity audit + remediation plans

- New spec `plugins/p-flow/docs/specs/2026-05-27-superpowers-parity.md` — systematic comparison of p-flow against superpowers v5.1.0 across 5 dimensions (skill inventory, architectural patterns, native tool integration, naming/conventions, behavioral output). 24 gaps classified by priority + 4 user decisions recorded.
- New master plan `plugins/p-flow/docs/plans/2026-05-27-superpowers-parity-remediation.md` — 4 waves (A/B/C/D) with Wave A detailed and B/C/D outlined.

## v4.6.4 — 2026-05-27

- Root README `## Repository layout` tree now shows all 4 plugins (was missing p-tasks + p-statusline).
- New `## Known limitations` section in `plugins/p-flow/README.md` documenting reviewer scope-discipline (sonnet ~80% / haiku ~0%), Sonnet+ model requirement, and the manual smoke-test contract for behavioral validation.

## v4.6.3 — 2026-05-27 — reviewer scope-discipline fix + Tier 1 structural tests

- Reviewer agents (`code-reviewer.md` + `task-reviewer.md`) get stronger "What is NOT your scope" wording (`MUST omit` + explicit examples) + a final scope self-check step at end of Procedure. Verified on Sonnet: false Blockers eliminated; residual is a Suggestion that self-rationalizes as "doc consistency".
- 6 new structural tests (Tier 1 coverage): branchSafe substitution cases; plan.md canonical section consistency per-file; branch type list consistency; agent tools must not include Write/Edit; agent body must declare `## What is NOT your scope`; plugin README must mention every skill in its `skills/` directory.

## v4.6.2 — 2026-05-27 — Wave 1 follow-ups

- Root README p-flow section updated to reflect post-Wave-1 surface.
- `writing-plan` plan template — literal `...` markers in second example step replaced with the full placeholder text (fixes self-review false trigger).
- `plugins/p-flow/README.md` "Skills (auto-invoked)" → "Skills (invoked by commands or context)" (was an overclaim — skills are model-invoked, not cron-like auto).
- 2 new tests: `tests/p-flow-marker-consistency.test.ts` (marker path matches between `verification-before-completion` and `task-end`); `tests/p-flow-verification-e2e.test.ts` (executable spec for the marker-write + .gitignore-append rules).

## v4.6.1 — 2026-05-27 — first structural tests for new surface

- 2 new tests: `tests/agents.test.ts` (frontmatter shape, read-only tools, body length) — superseded in v4.7.0; `tests/subagent-refs.test.ts` (every `subagent_type: <name>` in a SKILL.md resolves to a registered agent) — also superseded in v4.7.0.
- New `findAgents` helper in `tests/helpers.ts` — removed in v4.7.0.

## v4.6.0 — `plugins/p-flow 0.2.0` — 2026-05-27 — task development flow (Wave 1)

- Initial release of the p-flow task development flow surface beyond `init`. 7 new skills:
  - `task-brainstorming`, `writing-plan`, `verification-before-completion`,
  - `requesting-code-review`, `requesting-task-review`,
  - `task-start`, `task-end`.
- 2 new agents (subagents): `code-reviewer`, `task-reviewer` — both read-only, three-severity output (blocker / suggestion / nit). **Migrated to inline templates in v4.7.0.**
- Rules template (`_shared/templates/rules-p-flow.template.md`) gains a `## 4. Skills and flow` section + relaxation of the §3 "N/A" rule.

## Pre-v4.6 history

The plugin existed as `init`-only before the v4.6.0 release. See `git log` and `plugins/p-flow/docs/plans/2026-05-19-p-flow-plugin.md` for the original scaffolding plan.
