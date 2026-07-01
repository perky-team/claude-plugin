# p-flow Release Notes

> Marketplace tag → p-flow plugin version → date → headline.
> Authored 2026-05-27; backfilled from `v4.6.0` onward (the first p-flow release on the marketplace was `v3.1.0` with `plugins/p-flow 0.1.0` — a minimal `init` skill; see `git log v4.5.0..v4.6.0 -- plugins/p-flow/`).

## v5.8.1 — `plugins/p-flow 1.4.1` — 2026-07-01 — hook comment cleanup

- `hooks/session-start`: dropped the external `obra/superpowers` issue link from the
  bash-heredoc-workaround comment (comment-only; no behaviour change). Completes the
  removal of superpowers references from p-flow's runtime artifacts — only design-history
  docs still mention it, by design.

## v5.8.0 — `plugins/p-flow 1.4.0` — 2026-07-01 — subagent-driven-development skill + prior-art consultation

- **New `subagent-driven-development` skill** — an isolated, in-session execution mode alongside
  the existing inline `executing-plan`. The controller dispatches a **fresh implementer subagent
  per plan step**, runs a **per-step review** (spec compliance + code quality) after each, and a
  **broad whole-branch review** at the end. Artifacts (task brief, review package, implementer
  report) are handed over as files under `.p-flow/sdd/` so the controller's context stays clean;
  no step text or diff is pasted into a dispatch prompt.
  - Dispatch is `Task` + `subagent_type: general-purpose` + colocated inline templates
    (`implementer-prompt.md`, `task-reviewer-prompt.md`) — the Wave A pattern, never registered
    subagents. The final broad review reuses the canonical `requesting-code-review/code-reviewer.md`.
  - Progress ledger reuses the p-tasks gate: p-tasks sub-tasks (canonical) or plan.md `## Steps`
    checkboxes (legacy) — no separate ledger file. Compaction-safe.
  - Every dispatch specifies `model` explicitly (cost/speed control per role).
- **`writing-plan` hand-off now offers a choice** between `executing-plan` (inline) and
  `subagent-driven-development` (isolated). `using-p-flow` + README updated to describe both.
- **Fully decoupled** — no external-plugin dependency, no `superpowers` string, no `.superpowers/`
  path. Pinned by the new `tests/p-flow-sdd-decoupling.test.ts`.
- **Prior-art consultation in `task-brainstorming`.** When a task hinges on an approach — a
  library/framework/protocol/algorithm choice, a best-practice-sensitive domain, or an approach
  novel to the codebase — the skill may look up how it's commonly solved and record a **cited**
  recommendation in `adr.md`. Judgment-gated (not marker-gated): opt-in, never automatic, never
  a precondition, and never offered for routine work. Prefers delegation — `context7` for
  version-accurate library docs, `/deep-research` for deep questions — falling back to a bounded
  `WebSearch` / `WebFetch`. No plugin dependency (`context7`/`deep-research` used when present;
  web tools added to `task-brainstorming` allowed-tools). Contract:
  `skills/_shared/prior-art-bridge.md`; pinned by `tests/p-flow-prior-art-bridge.test.ts`.
- Cleanup: removed the remaining `superpowers` mentions from `task-end` and `writing-skills`
  skill bodies (design-history docs untouched).

## v5.6.0 — `plugins/p-flow 1.2.0` — 2026-06-25 — execution loop + p-wiki & p-graph bridges

- **Closed the execution-loop gap.** Two new skills replace the "Wave 2" placeholders that
  `verification-before-completion` and `requesting-code-review` referenced:
  - `executing-plan` — drives `specs/<slug>/plan.md` `## Steps` in order, one at a time:
    `test-driven-development` for code steps, `verification-before-completion` after each,
    `- [x]` checked off only on green. The loop between `writing-plan` and `task-end`.
  - `systematic-debugging` — where a red verification routes: reproduce → one falsifiable
    hypothesis → test it → narrow (bisect) → root-cause fix → re-verify.
  The stale "Wave 2" / "wait for `executing-plan`" wording is gone; review follow-ups now
  point to `receiving-code-review` (verify-the-finding-first).
- **Optional p-wiki bridge** (active only when `docs/wiki/.pwiki.json` exists):
  `task-brainstorming` offers to query prior wiki knowledge before designing; `task-end`
  offers to compile the task's decisions (`adr.md`, else `specification.md`) into the wiki.
  Capture uses `compile` (not `ingest`, which refuses in-repo paths); warns before publishing
  to Confluence Cloud. Contract: `skills/_shared/pwiki-bridge.md`.
- **Optional p-graph bridge** (active only when `.pgraph/config.json` exists): `writing-plan`
  consults the code graph during decomposition for the change's impact set, folding downstream
  callers into `## Risks`. **Advisory and read-only** — p-graph exposes no query skill, so the
  bridge defers the actual commands to the repo rule `/p-graph:init` installs
  (`.claude/rules/p-graph.md`) and uses the Skill tool only for `p-graph:sync`. Keeps p-flow
  uncoupled from p-graph's pre-1.0 CLI. Contract: `skills/_shared/pgraph-bridge.md`.
- **No coupling, same as the p-tasks bridge.** No `plugin.json#dependencies`; no sibling-CLI
  calls (`pwiki.mjs` / `pgraph.mjs` absent from every skill); both bridges gate on a marker
  file and are silent no-ops when the sibling isn't installed. Two new decoupling tests:
  `tests/p-flow-pwiki-bridge.test.ts` and `tests/p-flow-pgraph-bridge.test.ts`.

## v5.5.0 — `plugins/p-flow 1.1.0` — 2026-06-25 — optional p-tasks bridge

- p-flow now offers a **soft, opt-in** bridge to the `p-tasks` tracker, active **only** when p-tasks is initialised in the same repo (detected by `docs/tasks/.ptasks.json`).
  - `writing-plan` — after the plan is approved, offers to create a p-tasks `task` named `<slug>` plus one `sub-task` per `## Steps` item.
  - `task-end` — after the MR recommendation, offers to mark the `<slug>` task **and its sub-tasks** `done` (p-tasks has no status cascade, so both are closed explicitly).
- **No coupling.** No `plugin.json#dependencies` (the platform's dependency field is hard/required and would break standalone p-flow); the bridge dispatches through the Skill tool (`p-tasks:add` / `p-tasks:set` / `p-tasks:next`), never p-tasks' CLI, so per-plugin isolation holds. `p-tasks` is untouched and unaware of p-flow. Both plugins still install/run standalone.
- Every mirror action is an explicit offer — never silent — and warns before creating real Jira issues when the p-tasks destination is `jira`.
- Contract centralised in `skills/_shared/ptasks-bridge.md`. Two new tests: `tests/p-flow-ptasks-bridge.test.ts` guards independence (no `plugin.json#dependencies`), decoupling (no `ptasks.mjs` in any skill), and the gate; `tests/p-flow-ptasks-recipe.test.ts` is an executable spec that drives the real p-tasks CLI through the bridge recipe and pins the no-status-cascade assumption. Behaviour (does the model fire/gate/confirm correctly) is covered by a manual smoke-test checklist in `docs/plans/2026-06-25-ptasks-bridge.md`.

## v5.0.0 — `plugins/p-flow 1.0.0` — 2026-06-16 — first stable release

- Promotes p-flow to its first stable major. **No functional changes** since `0.7.1` — this is a stability declaration: the command set (`init`, `task-start`, `task-end`), the 13-skill stack, the plan.md section contract, the verification marker path, and the reviewer-template dispatch pattern are considered settled after five design waves (A–E).
- Known limitations are unchanged and documented (reviewer scope ~80% on Sonnet; Sonnet+ required for review dispatch; SessionStart discovery needs Git-Bash on PATH on Windows). See README `## Known limitations`.

## v4.17.1 — `plugins/p-flow 0.7.1` — 2026-06-15 — task-start invocation + tooling fixes

- `/p-flow:init` and `README.md` now instruct `/p-flow:task-start <slug>` (bare slug — the branch type is asked interactively), not `/p-flow:task-start <type>/<slug>`. The prefixed form was swallowed whole into the slug, producing a doubled-type branch `feature/feature/<slug>` and `specs/feature/<slug>/`.
- `init` `allowed-tools` gains `Bash(grep:*) Bash(echo:*)` and `task-end` gains `Bash(grep:*)` — their Bash snippets pipe through `grep`/`echo`, which Claude Code's per-subcommand permission check would otherwise prompt for mid-skill.
- `init` replaces a fragile hardcoded `task-brainstorming/SKILL.md:41` line reference with a section anchor.
- New `tests/p-flow-cross-skill-consistency.test.ts` block guards the `task-start` invocation form (no `<type>/` prefix in any skill body or README).

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
