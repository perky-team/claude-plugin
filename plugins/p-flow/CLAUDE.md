# p-flow — contributor guide

Conventions specific to the `p-flow` plugin. Repo-wide rules live in `/.claude/CLAUDE.md` at the marketplace root.

For authoring or editing **skills**, see also `skills/writing-skills/SKILL.md` — it covers frontmatter, body sections, dispatch patterns, and test coverage in detail. This file documents the architecture decisions and plugin-wide conventions that aren't per-skill.

---

## Architecture decisions

| Decision | Wave | Doc |
|---|---|---|
| Reviewers as inline templates colocated with their requesting skill, dispatched via `Task` tool with `subagent_type: general-purpose` — NOT registered subagents in `agents/<name>.md`. | A | `docs/plans/2026-05-27-superpowers-parity-remediation.md` |
| Discovery via SessionStart hook (`hooks/hooks.json` + `hooks/session-start` + `hooks/run-hook.cmd` polyglot wrapper) emitting `using-p-flow/SKILL.md` content as a `<system-reminder>`. | B | `docs/plans/2026-05-27-wave-b-discovery.md` |
| Two plan template variants in `_shared/templates/` (TDD-aligned + generic); `writing-plan` heuristically suggests + asks user to confirm. Templates stay skill-internal (not copied into user repo by `/p-flow:init`). | C | `docs/plans/2026-05-27-wave-c-tdd-receiving-review.md` |
| `task-end` stays narrow — push + MR-recommend only, no merge/PR/cleanup menu. See `skills/task-end/SKILL.md` `## Design note`. | D | `docs/plans/2026-05-27-wave-d-cleanup.md` |
| `/p-flow:init` extended with Phase 2 — a repo-level feature brainstorm that materialises stub `specs/<slug>/specification.md` files. No new skill (kept inside `init`); no `specs/roadmap.md` or `specs/repo.md` feature index — folders are canonical, `task-brainstorming` refine-mode handles deeper work. State-machine guard on re-run: refuse iff any `specs/<slug>/` folder exists. | E | `docs/plans/2026-05-27-init-brainstorm-phase.md` |
| Gated bridge to `p-tasks`: gated on `docs/tasks/.ptasks.json`, dispatched via the Skill tool (`p-tasks:add`/`set`/`list`/`summary`/`next`) NOT its CLI, join-key = task title == `<slug>`. NO `plugin.json#dependencies` (platform deps are hard/required; would break standalone p-flow). p-tasks untouched. **When present, p-tasks is the canonical store and there is NO `plan.md`** — `writing-plan` writes sub-tasks + an Overview in the parent task description (no plan.md at all), `executing-plan` walks `list`, review skills add `origin: code-review:*` sub-tasks (defer/reject = done sub-tasks carrying a `resolution`), `task-end` counts/closes them and sources narrative from `specification.md`. `fs` store is driven inline (local/reversible); Jira writes warn first. When absent, the legacy plan.md-only flow is byte-for-byte unchanged. | F | `docs/plans/2026-06-25-ptasks-bridge.md` |
| Execution loop owned by p-flow (parity approach): `executing-plan` drives `## Steps` (TDD per code step, verify after each, check off only on green); `systematic-debugging` is the red-verification route. Replaces the "Wave 2" placeholders. `executing-plan` owns `## Steps`; `## Review follow-ups` stay with `receiving-code-review`. | G | `skills/executing-plan/SKILL.md`, `skills/systematic-debugging/SKILL.md` |
| Two execution modes: `executing-plan` (INLINE — implement in the current session) and `subagent-driven-development` (ISOLATED — fresh implementer subagent per step + per-step review, artifacts handed over as files under `.p-flow/sdd/`). `writing-plan` hands off to a user choice between them. SDD dispatches `Task` + `general-purpose` + colocated inline templates (never registered subagents), reuses `requesting-code-review/code-reviewer.md` for the final broad review, and uses the same p-tasks/checkbox ledger via the p-tasks gate. No external-plugin coupling (no `superpowers`, no `.superpowers/`). | H | `docs/plans/2026-07-01-subagent-driven-development.md`, `skills/subagent-driven-development/SKILL.md` |
| Prior-art consultation in `task-brainstorming`: a **judgment-gated** (not marker-gated) contract — offered only for approach/library/best-practice-sensitive tasks, never routine, never automatic, never a precondition. Prefers delegation (`context7`, `/deep-research`) over the built-in `WebSearch`/`WebFetch`; records cited recommendations in `adr.md`. NO `plugin.json#dependencies` — context7/deep-research used when present; web tools are the only hard capability (added to `task-brainstorming` allowed-tools). | I | `skills/_shared/prior-art-bridge.md`, `skills/task-brainstorming/SKILL.md` |
| Optional soft bridge to `p-wiki`: gated on `docs/wiki/.pwiki.json`, dispatched via the Skill tool (`p-wiki:query` read at `task-brainstorming`, `p-wiki:compile` write at `task-end`) NOT its CLI. Capture is `compile` NOT `ingest` (ingest refuses in-repo paths). Offers never silent; Confluence warning on confluence destinations. NO `plugin.json#dependencies`. | G | `skills/_shared/pwiki-bridge.md` |
| Optional soft bridge to `p-graph`: gated on `.pgraph/config.json`, used by `writing-plan` during decomposition. **Advisory + read-only** (no offer) — p-graph has no query skill, so the bridge defers structural queries to the installed repo rule `.claude/rules/p-graph.md` and uses the Skill tool only for `p-graph:sync`. Does NOT duplicate p-graph's pre-1.0 command table. NO `plugin.json#dependencies`. | G | `skills/_shared/pgraph-bridge.md` |

If you're tempted to revisit any of these — read the linked plan and spec first. The decisions are documented because they were made deliberately and shouldn't be re-litigated on a per-PR basis.

## Reviewer templates (Wave A pattern)

- The two reviewer prompts live colocated with their requesting skills:
  - `skills/requesting-code-review/code-reviewer.md`
  - `skills/requesting-task-review/task-reviewer.md`
- The requesting SKILL.md reads the template via `${CLAUDE_SKILL_DIR}/<reviewer>.md` and inlines its content into the `Task` tool prompt.
- **Structural invariant** (enforced by `tests/review-template-refs.test.ts`) — each template MUST contain a `## What is NOT your scope` section. This is the scope-discipline mechanism; removing it weakens the agent.

## Severity model

Both reviewers emit a 3-severity output: **Blockers / Suggestions / Nits** (plural, sentence-case headings).

- **Blocker** — correctness/security/spec-missing-AC issue. Must be addressed before ship.
- **Suggestion** — improvement worth considering. Triage protocol: `fix` / `defer` / `reject`.
- **Nit** — cosmetic / minor. Default action `reject all`.

`requesting-code-review` and `requesting-task-review` share the same triage protocol so the user can apply the same mental model to both reports. The triage protocol is prose (not `AskUserQuestion`) because the per-severity flows need more than 4 options.

## plan.md canonical sections

Every `specs/<slug>/plan.md` produced by p-flow uses these section headings (don't rename, don't reorder):

| Section | Written by | Counted by `task-end`? |
|---|---|---|
| `## Steps` | `writing-plan` template | yes (completeness check) |
| `## Review follow-ups — <YYYY-MM-DD>` | `requesting-*-review` (lazy create) | yes |
| `## Review decisions (audit)` | `requesting-*-review` (lazy create) | no (audit only) |
| `## Open questions` | `writing-plan` template | no |
| `## Risks` | `writing-plan` template | no |

**Enforced by** `tests/p-flow-cross-skill-consistency.test.ts` — each skill that emits/anchors against a heading is required to use the canonical spelling.

**Canonical mode (p-tasks present):** there is **no `plan.md`** at all. The step list, review follow-ups, and the review audit all live in p-tasks as sub-tasks (the audit = done sub-tasks carrying a `--resolution "deferred|rejected: <reason>"`); the narrative (Overview / Risks / Open questions) lives in `specs/<slug>/specification.md`, with a concise Overview also in the parent task's description. The table above describes the legacy (p-tasks-absent) plan.md only. Both paths are gated by `_shared/ptasks-bridge.md`.

## Slug + branch type conventions

- Branch format: `<type>/<slug>` where `<type>` ∈ `{feature, bugfix, hotfix, chore, docs}`.
- Slug: kebab-case, lowercase, ≤ 50 chars, alphanumeric + hyphens only.
- Skills resolve `<slug>` from the branch name by stripping the `<type>/` prefix. If the branch doesn't match, ask the user. `task-end` will skip plan-related pre-checks if no slug can be resolved.
- **Enforced by** `tests/p-flow-cross-skill-consistency.test.ts` (branch type list consistency).

## Marker path for verification

`verification-before-completion` writes a state marker on success at:

```
.claude/.p-flow-state/<branch-safe>/last-verification
```

where `<branch-safe>` = current branch name with `/` → `__`. `task-end` reads this marker to detect whether verification ran recently.

- **Enforced by** `tests/p-flow-marker-consistency.test.ts` — both skills must reference the same path shape AND the same substitution rule.

## Test invariants

Each test file defends one invariant; if you change behaviour that affects an invariant, update the test in the same commit (no separate "fix tests" follow-up).

| Test | What it defends |
|---|---|
| `tests/skills.test.ts` | Every SKILL.md has valid frontmatter (name matches dir, description ≥ 30 chars, allowed-tools parseable), body > 100 chars |
| `tests/plugin-readme-coverage.test.ts` | Every skill in `skills/` (except `_shared`) is mentioned in `plugins/<plugin>/README.md` via backticks or slash-command form |
| `tests/templates.test.ts` | Every template in `_shared/templates/` is referenced by at least one SKILL.md (dead-template check) |
| `tests/p-flow-marker-consistency.test.ts` | marker path agreement between `verification-before-completion` and `task-end` |
| `tests/p-flow-verification-e2e.test.ts` | executable spec for marker-write + .gitignore-append logic (re-implementation; update in lockstep with `verification-before-completion/SKILL.md`) |
| `tests/p-flow-cross-skill-consistency.test.ts` | plan.md canonical section spellings per file; branch type list |
| `tests/review-template-refs.test.ts` | Reviewer template files exist + contain `## What is NOT your scope` |
| `tests/p-flow-sdd-decoupling.test.ts` | `subagent-driven-development` ships its 3 files, stays decoupled (no `superpowers` / `.superpowers/` string), dispatches via `Task` + `general-purpose` (not registered subagents), routes the ledger through `_shared/ptasks-bridge.md`, and reuses the canonical `requesting-code-review/code-reviewer.md` for the final review. Also guards reachability: `writing-plan` hands off to both execution modes and `using-p-flow` lists the skill (else it orphans) |
| `tests/p-flow-init-phase2.test.ts` | `init/SKILL.md` Step 2 state-machine has 4 rows + uses `grep -q .` (not the broken `head -1`); README Idempotency table matches the SKILL state-machine cell-for-cell; Step 9 placeholder names exist in `specification.template.md` |
| `tests/p-flow-ptasks-bridge.test.ts` | p-tasks bridge stays decoupled (no `plugin.json#dependencies`, no `ptasks.mjs` in any skill) and gated (host skills reference `_shared/ptasks-bridge.md`; bridge doc keeps "absent → silent no-op" AND the canonical-store rule: p-tasks is the single artifact, NO plan.md exists, narrative → `specification.md`, audit → done sub-tasks carrying a `resolution`; the old slim plan template is deleted and `writing-plan` writes no plan.md in canonical mode) |
| `tests/p-flow-ptasks-recipe.test.ts` | executable spec: the canonical recipe (create task=`<slug>` + sub-tasks with acceptance/files/kind/origin → walk via `list` → close all) yields a correct p-tasks store; pins the no-status-cascade assumption `task-end` relies on (re-implementation via the real p-tasks CLI — update if the bridge recipe changes) |
| `tests/p-flow-pwiki-bridge.test.ts` | p-wiki bridge stays decoupled (no `plugin.json#dependencies`, no `pwiki.mjs` in any skill) and gated (host skills `task-brainstorming` + `task-end` reference `_shared/pwiki-bridge.md`; bridge doc keeps "absent → silent no-op" AND the compile-not-ingest rule) |
| `tests/p-flow-pgraph-bridge.test.ts` | p-graph bridge stays decoupled (no `plugin.json#dependencies`, no `pgraph.mjs` in any skill) and gated (`writing-plan` references `_shared/pgraph-bridge.md`; bridge doc keeps "absent → say nothing", uses only `p-graph:sync` via Skill tool, and defers queries to `.claude/rules/p-graph.md`) |
| `tests/p-flow-prior-art-bridge.test.ts` | prior-art bridge doc exists + is judgment-gated (not marker-gated), stays decoupled (no `plugin.json#dependencies`; prefers `context7`/`deep-research`, only hard capability is the built-in web tools), pins the "opt-in, never automatic, never a precondition" discipline and cite-in-ADR rule; `task-brainstorming` references the bridge and declares `WebSearch`/`WebFetch` in allowed-tools |

## How to add a new skill

1. Use `skills/writing-skills/SKILL.md` as the authoring checklist.
2. Add the skill body following the established section order (`## When to use` → `## Inputs` → `## Procedure` → `## Hard rules` → `## Red flags — STOP` → `## What this skill does NOT do`).
3. Prepend an `**Announce at start:**` line right after the H1 description (convention from Wave D).
4. Add the skill to `plugins/p-flow/README.md`'s `## Skills` table — `plugin-readme-coverage.test.ts` will fail without it.
5. Add the skill to `skills/using-p-flow/SKILL.md`'s `## Skills (model-invoked when context applies)` table so the discovery hook surfaces it.
6. If the skill emits/anchors canonical plan.md sections, add an explicit assertion in `tests/p-flow-cross-skill-consistency.test.ts`.
7. If the skill ships a colocated reviewer template (rare — only review skills do this), add `tests/review-template-refs.test.ts` assertions automatically apply.
8. Bump `plugins/p-flow/.claude-plugin/plugin.json` `version` (minor for additive). Update the description's skill enumeration.

## How to release p-flow

- Marketplace tag (e.g. `v4.X.Y`) — the cross-plugin semver. Per repo CLAUDE.md.
- `plugins/p-flow/.claude-plugin/plugin.json` `version` — plugin-internal semver. Bump alongside the marketplace tag when p-flow itself changed.
- Append a `## v<X.Y.Z>` section to `plugins/p-flow/RELEASE-NOTES.md` BEFORE pushing the tag.
- `git tag` only after explicit user confirmation (per repo CLAUDE.md "never tag silently").

## Known limitations

Cross-reference — see `plugins/p-flow/README.md` `## Known limitations`. Repeated here for contributors:

- Reviewer scope-discipline is best-effort. On Sonnet, ~20% topical overlap between `code-reviewer` and `task-reviewer` outputs is expected. Behavioural validation is manual smoke-test only — there's no automated way to assert prompt discipline.
- p-flow requires Sonnet+ for review-template dispatch. Weaker models ignore the negative-scope directives.
- `using-p-flow` discovery hook on Windows requires Git-Bash on PATH (or in a standard Git for Windows install path). Falls back to silent no-op if absent.

## What lives where

```
plugins/p-flow/
├── .claude-plugin/plugin.json   ← plugin manifest (name, version, description)
├── README.md                    ← user-facing docs (Commands, Skills, Reviewer templates, Known limitations)
├── CLAUDE.md                    ← this file (contributor docs)
├── RELEASE-NOTES.md             ← per-version changelog
├── hooks/                       ← SessionStart hook (Wave B)
│   ├── hooks.json
│   ├── session-start            ← bash; emits using-p-flow body as <system-reminder>
│   └── run-hook.cmd             ← polyglot wrapper for Windows + Unix
├── skills/
│   ├── _shared/templates/       ← templates (4 init-copied + 2 plan-internal)
│   ├── _shared/ptasks-bridge.md  ← shared p-tasks integration contract (gate + dispatch + join-key)
│   ├── _shared/pwiki-bridge.md   ← shared p-wiki integration contract (query in / compile out)
│   ├── _shared/pgraph-bridge.md  ← shared p-graph integration contract (advisory impact analysis)
│   ├── _shared/prior-art-bridge.md ← external prior-art consultation contract (judgment-gated; context7/deep-research/web)
│   ├── init/                    ← /p-flow:init slash command
│   ├── task-start/              ← /p-flow:task-start slash command (Phase A + Phase B)
│   ├── task-end/                ← /p-flow:task-end slash command
│   ├── using-p-flow/            ← discovery skill (auto-emitted by hook)
│   ├── task-brainstorming/      ← spec authoring
│   ├── writing-plan/            ← plan authoring (TDD or generic)
│   ├── executing-plan/          ← drives plan.md ## Steps INLINE (TDD per step, verify, check off)
│   ├── subagent-driven-development/  ← ISOLATED execution: fresh implementer subagent per step + per-step review
│   │   ├── implementer-prompt.md ← inline implementer template (Task + general-purpose)
│   │   └── task-reviewer-prompt.md ← inline per-step reviewer template (spec + quality)
│   ├── verification-before-completion/  ← test/lint gate before "done"
│   ├── test-driven-development/ ← RED-GREEN-REFACTOR enforcement before code
│   ├── systematic-debugging/    ← root-cause method when verification fails
│   ├── requesting-code-review/  ← dispatches code-reviewer.md template
│   │   └── code-reviewer.md     ← inline reviewer template (Wave A)
│   ├── requesting-task-review/  ← dispatches task-reviewer.md template
│   │   └── task-reviewer.md     ← inline reviewer template (Wave A)
│   ├── receiving-code-review/   ← verify-first discipline for review feedback
│   ├── using-git-worktrees/     ← reference doc for worktrees
│   └── writing-skills/          ← meta-skill for authoring/editing skills
└── docs/
    ├── plans/                   ← implementation plans by date
    └── specs/                   ← design specs by date
```

(Note: no `agents/` directory — removed in Wave A; reviewers live as inline templates colocated with their requesting skills.)
