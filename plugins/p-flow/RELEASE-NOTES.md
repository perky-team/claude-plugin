# p-flow Release Notes

> Marketplace tag → p-flow plugin version → date → headline.
> Authored 2026-05-27; backfilled from `v4.6.0` onward (the first p-flow release on the marketplace was `v3.1.0` with `plugins/p-flow 0.1.0` — a minimal `init` skill; see `git log v4.5.0..v4.6.0 -- plugins/p-flow/`).

## `plugins/p-flow 1.10.1` (marketplace `v6.4.1`) — headless `requesting-code-review` takes its task from a `--task` argument, never from the branch

- **As shipped in 1.10.0 the headless path could not resolve a task in the deployment it was built
  for.** Precondition 3 derived `<slug>` by stripping the `<type>/` prefix off the current branch and
  required a p-tasks task with exactly that title — p-flow's own one-branch-per-task model. The
  autonomous loops it targets cannot work that way: they live on ONE long-lived branch and take
  whichever task `p-tasks:next` hands them, so the task changes every run while the branch never
  does. Measured on both live deployments on 2026-08-07: branch `auto/dev` → slug `dev`; 39 and 105
  top-level tasks, **0** titled `dev`. Every headless run stopped on precondition 3 and nothing past
  it was reachable.

- **Non-interactive resolution order is now:** the skill's argument — `--task <t-id|task-title>`,
  either the p-tasks task id (`t-7`) or the task's exact title (the `<slug>`, per the bridge's join
  key) — else the single top-level task with status `in_progress`, usable **only when there is
  exactly one** (one live deployment has three, so the qualifier is load-bearing) — else a stop. The
  argument is the intended path: the caller has just taken the task from `p-tasks:next` and knows
  which one it is working on. An argument that matches nothing **never falls through** to the
  fallback; reviewing a different task is worse than stopping.

- **Three distinct named stops**, because the operator's fix differs for each: `--task <value>`
  matches no p-tasks task; no argument and no task `in_progress`; no argument and `<N>` tasks
  `in_progress` (which lists them).

- **Also fixed in the same block:** the non-interactive Goal was to be read via `p-tasks:list
  <slug>`, which returns that task's *sub-tasks*, not the task itself — so the parent's
  `description` was never in the response. It now comes from the whole-project listing the
  resolution already makes.

- **Interactive is untouched** — the branch is still the right source with a human at the keyboard,
  and a new assertion pins that sentence verbatim. `tests/p-flow-noninteractive.test.ts` grows from
  12 to 17 assertions; the design record is amended in
  `docs/specs/2026-08-07-noninteractive-mode.md`.

## `plugins/p-flow 1.10.0` (marketplace `v6.4.0`) — `requesting-code-review` runs headless under `P_FLOW_NONINTERACTIVE=1`

- **New shared gate `skills/_shared/noninteractive.md`.** `P_FLOW_NONINTERACTIVE=1` — exactly `1` —
  puts a skill in non-interactive mode. Any other value, including unset, empty, `0` and `true`, is
  interactive: **every question is put exactly as before, in the same words**, and the gate is a
  silent no-op. The narrow accepted value is deliberate — a typo degrades to the safe mode, asking a
  human. The doc carries the gate and the one rule (never ask: apply a default documented next to
  the question it replaces, or stop with a named reason; never invent an answer that is the user's
  to decide); each host skill carries its own defaults.

- **`requesting-code-review` is the first host, and can now run in a headless `claude -p` job** — a
  p-shed worker, a CI step. Two defaults:
  - **Preconditions.** The `specs/<slug>/specification.md` requirement is dropped; `<slug>` comes
    from the parent p-tasks task title (the bridge's join key, confirmed via `p-tasks:list`), and
    the reviewer's Goal is composed from that task's `--description`. Non-interactive mode
    **requires p-tasks**: absent — or present with a `jira` destination whose writes need a human
    yes — the run stops with a named reason instead of guessing or falling back to legacy. The Jira
    check runs before the reviewer is dispatched, so a headless run does not burn a review it could
    not record.
  - **Triage.** Blockers and Suggestions are accepted (`fix`) and filed as `code-review:*` follow-up
    sub-tasks; Nits are deferred with reason *nit declined (non-interactive default)* rather than
    rejected. **`reject` is unavailable** — asserting that a reviewer was wrong is a judgement
    reserved for a human — so nothing is dropped: every finding lands in p-tasks with a decision
    attached, recorded through the same calls a human's triage uses. The audit trail has the same
    shape either way.

- **Nothing interactive changed.** With `P_FLOW_NONINTERACTIVE` unset the skill emits byte-identical
  output and the same questions as 1.9.2. `code-reviewer.md` is untouched and stays mode-neutral, so
  `subagent-driven-development`'s final broad review is unaffected. No new plugin dependency.

- `allowed-tools` gains `Bash(test:*)` (the gate probe) and `Skill` (p-tasks dispatch). `Skill`
  closes a pre-existing gap — §5 canonical mode already dispatched `p-tasks:add` without declaring
  it. New suite `tests/p-flow-noninteractive.test.ts`; spec in
  `docs/specs/2026-08-07-noninteractive-mode.md`.

## `plugins/p-flow 1.9.2` (marketplace `v5.16.2`) — native task-list works on current Claude Code (Task tools, not just legacy TodoWrite)

- **`executing-plan` and `subagent-driven-development` no longer depend on the phased-out `TodoWrite`
  tool.** Recent Claude Code versions default to the new task-list tools (`TaskCreate` / `TaskUpdate` /
  `TaskList`) and disable `TodoWrite` unless `CLAUDE_CODE_ENABLE_TASKS=0` is set — so both skills, which
  named only `TodoWrite`, silently created no list and `Ctrl+T` showed nothing. The native-task-list
  sections are now tool-independent: prefer the `Task*` tools when available, fall back to `TodoWrite`
  only when they are not, never use both, and never skip the list because one tool is missing.
  `TaskCreate TaskUpdate TaskList` added to both skills' `allowed-tools` alongside `TodoWrite`. No
  behaviour change beyond the list now actually appearing.

## `plugins/p-flow 1.9.1` (marketplace `v5.16.1`) — TDD vs generic plan choice is a digit-menu with per-option recommendation

- **`writing-plan` step 2 now presents the plan-variant choice as a numbered menu.** Instead of a single
  one-line suggestion (*"I'd suggest a TDD/generic plan, confirm or override?"*), it shows both options —
  `1. TDD plan` and `2. Generic plan` — each stating whether it's recommended **for this spec** and the
  concrete reason drawn from the spec's own content, with exactly one marked `*Recommended*` (per the
  existing feature-file / behaviour-in-AC heuristic). The user answers with a single digit, or a bare
  approval takes the recommended one. No `AskUserQuestion` — plain prose. The heuristic and templates are
  unchanged; only the prompt presentation changed.

## `plugins/p-flow 1.9.0` (marketplace `v5.16.0`) — SDD is the default execution mode; live native task-list

- **`writing-plan` now recommends `subagent-driven-development` by default.** After the plan is approved,
  the hand-off is a numbered menu the user can answer with a single digit — `1` (SDD, separate agents,
  the recommended default) or `2` (`executing-plan`, inline in this session). A bare approval also picks
  SDD. The rationale: by the time the plan exists, the context is already heavy (brainstorm + spec +
  plan), so a fresh implementer subagent per step keeps the main context clean. No `AskUserQuestion` —
  plain prose. `using-p-flow`, the README, and the contributor `CLAUDE.md` all now name SDD the default.
- **`executing-plan` and `subagent-driven-development` maintain the native task list.** Both skills now
  mirror the step ledger onto Claude Code's built-in task list (the `TodoWrite` tool, toggled with
  `Ctrl+T`): one todo per step, flipped `in_progress` at step start and `completed` when the step
  verifies green. The durable ledger (p-tasks sub-tasks / `plan.md` checkboxes) stays the source of
  truth — the todo list is a live view. In SDD only the controller touches it; subagents never do.
  `TodoWrite` added to both skills' `allowed-tools`.
- **Audit fixes across the plugin.** `subagent-driven-development` marks the diff-range bases as
  substituted SHAs (`<BASE>`/`<MERGE_BASE>`) so the review-package git commands can't be copied
  verbatim into a failing `git log BASE..HEAD`; `writing-plan` + `pgraph-bridge` now say where impact
  notes go in canonical mode (`specification.md`'s `## Risks`, since there is no `plan.md`); the README
  no longer claims a non-existent reviewer agent frontmatter; and several doc/wording inconsistencies
  (`verification-before-completion` marker path in its description, `task-end` parent/slug phrasing,
  `spec-auditor` task-type framing, `pwiki-bridge` legacy-only `plan.md` note, template count in
  `CLAUDE.md`) were corrected.

## `plugins/p-flow 1.8.0` (marketplace `v5.15.0`) — task-end clears the SDD workspace after push

- **`/p-flow:task-end` now clears the `subagent-driven-development` workspace (`.p-flow/sdd/`) once the
  branch is confirmed pushed.** The skill's briefs, diffs, and reports (`task-<n>-brief.md`,
  `task-<n>-report.md`, `review-<n>.diff`, …) used to pile up across tasks and sessions — the folder
  is git-ignored, so nothing ever removed them. They now get cleared at the natural end of a task.
- **Only after a successful push, never before.** Those artifacts double as the resume journal for an
  interrupted SDD run (the resume path reads `.p-flow/sdd/task-<n>-*` to reconcile an `in_progress`
  step), so `subagent-driven-development` itself must not delete them. A successful push is the one
  point where the run is finished and there is nothing left to resume; if the push failed or was never
  reached, the cleanup is skipped and the journal is preserved.
- **Safe and idempotent.** `.p-flow/sdd/.gitignore` (which holds `*`) is kept so the folder stays
  invisible to git; a missing `.p-flow/sdd/` (inline `executing-plan` was used) is a silent no-op; and
  `.claude/.p-flow-state/` (the verification marker) is never touched. The user gets one line stating
  how many files were removed.

## `plugins/p-flow 1.7.1` (marketplace `v5.14.1`) — SDD model-selection floor

- **`subagent-driven-development` §Model selection now states the cheap-tier floor explicitly.** The
  cheapest tier applies only when the plan already contains the code to write; for prose-described
  steps and all reviewers the floor is mid tier, because cheap models routinely take 2–3× the turns
  on multi-step work and cost more overall. Restores the one behavioural cue that was dropped when
  the section was condensed from the upstream `superpowers` original — no dispatch mechanics change.

## `plugins/p-flow 1.7.0` (marketplace `v5.14.0`) — spec audit subagent in task-brainstorming

- **`task-brainstorming` now audits the spec with a fresh-context subagent instead of a shallow
  inline self-review.** After the spec is materialized (§4) and before the user review gate (§6),
  a `general-purpose` subagent (prompt = new colocated `spec-auditor.md`) reads the whole
  `specs/<slug>/` and hunts logical errors, internal contradictions, cross-file inconsistencies
  (`specification.md` ↔ `feature.feature` ↔ `adr.md`), coverage gaps, and scope creep.
- **The auditor fixes the spec directly** — a deliberate, spec-only exception to p-flow's
  "reviews are read-only" rule (specs are prose, cheap, and still pass the §6 human gate). Code
  and plan reviewers stay read-only.
- **Loop-until-clean, capped at 3 passes, Blockers-driven.** Suggestions/Nits are fixed in-pass
  but never keep the loop running; after 3 passes any remaining Blockers are surfaced to the user
  at §6.
- **Genuine ambiguity is escalated, not guessed.** When a fix needs a decision the spec doesn't
  contain, the subagent returns a question; `task-brainstorming` asks the user one at a time and
  re-dispatches with the answers.

## `plugins/p-flow 1.6.0` (marketplace `v5.13.0`) — canonical status lifecycle (todo → in_progress → done)

- **In canonical mode (p-tasks present), the execution skills now use the full three-state
  status lifecycle instead of only flipping `todo → done`.** This makes the tracker show what is
  *currently* being worked, and turns an interrupted run into a recoverable signal.
  - `executing-plan` — sets the step's sub-task `--status in_progress` right **before implementing**
    it, and the parent task `in_progress` on the first step. `done` still only on a green
    `verification-before-completion` (unchanged).
  - `subagent-driven-development` — sets the step's sub-task `in_progress` right **before
    dispatching** its implementer subagent (parent on the first step); `done` only after the
    per-step review passes.
  - `receiving-code-review` — sets a review follow-up sub-task `in_progress` when work on it
    begins; `done` on resolution (`--resolution` for reject/defer, as before).
- **Interrupt / resume semantics.** On resume, an `in_progress` sub-task means the previous run was
  **interrupted** mid-step — the skills now reconcile it (inspect git + step artifacts, verify
  against the acceptance criterion, then finish or redo cleanly) instead of assuming it finished or
  blindly re-running it. The ledger now carries three meaningful states: `todo` = not started,
  `in_progress` = interrupted mid-step, `done` = verified-complete.
- **Reference.** `skills/_shared/ptasks-bridge.md` gains a `## Status lifecycle` section that is the
  canonical description the skills point to. `using-p-flow` and the README describe it too.
- **Legacy mode unchanged.** plan.md `- [ ]` / `- [x]` checkboxes are binary and cannot express
  in-progress; the legacy flow stays byte-for-byte the same. The gap (no interrupt signal) is noted
  in the docs as a reason the canonical/p-tasks flow is preferable.
- Cost: one extra `p-tasks:set --status in_progress` per step. Tests: new
  `tests/p-flow-ptasks-status-lifecycle.test.ts` (structural) + a lifecycle/interrupt-resume case in
  `tests/p-flow-ptasks-recipe.test.ts` (executable spec against the real p-tasks CLI).

## `plugins/p-flow 1.5.0` (marketplace `v5.10.0`) — canonical mode drops plan.md entirely

- **When p-tasks is present ("canonical mode"), p-flow no longer creates or requires
  `specs/<slug>/plan.md` at all.** p-tasks is now the single artifact for the step list, review
  follow-ups, and the review audit; the task narrative lives in `specs/<slug>/specification.md`
  (plus a concise Overview in the parent task's `--description`). This removes the last
  duplication: the old canonical `plan.md` only held narrative already in `specification.md` and
  a `## Review decisions (audit)` log that fits p-tasks' `origin` / `status` / `resolution` fields.
  - `writing-plan` — canonical mode creates the parent task + one sub-task per step (as before)
    and writes **no plan.md** and reads **no template**.
  - `executing-plan` / `subagent-driven-development` — canonical mode's required input is
    `specification.md` + the `<slug>` p-tasks parent task; the `plan.md` input gate is gone. The
    step list comes from `p-tasks:list <parent>` (unchanged).
  - `requesting-code-review` / `requesting-task-review` — canonical mode passes only
    `specification.md` to the reviewer (no plan.md). Deferred/rejected findings are recorded as
    done sub-tasks carrying `--origin <...>:<severity> --resolution "deferred|rejected: <reason>"`
    instead of a `## Review decisions (audit)` section.
  - `receiving-code-review` — canonical rejects/defers become `--status done --resolution
    "rejected|deferred: <reason>"` on the sub-task; no plan.md touch.
  - `task-end` — canonical mode sources completeness, "What changed", Summary, and Test-plan from
    p-tasks + `specification.md`; never reads plan.md.
- **Legacy mode (p-tasks absent) is byte-for-byte unchanged** — plan.md is still written, walked,
  checked off, and read exactly as before.
- Removed the now-unused `plan-tasks.template.md` (the old slim canonical plan template) and all
  references to it. Updated `_shared/ptasks-bridge.md`, the `rules-p-flow.template.md` flow table,
  `using-p-flow`, `task-brainstorming`, README, and CLAUDE.md to reflect the canonical/legacy split.
- Test invariants updated: `tests/p-flow-ptasks-bridge.test.ts` now pins "no plan.md in canonical
  mode" (narrative → `specification.md`, audit → done sub-tasks carrying a `resolution`, template
  deleted).

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
