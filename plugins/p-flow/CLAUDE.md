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
| `tests/p-flow-init-phase2.test.ts` | `init/SKILL.md` Step 2 state-machine has 4 rows + uses `grep -q .` (not the broken `head -1`); README Idempotency table matches the SKILL state-machine cell-for-cell; Step 9 placeholder names exist in `specification.template.md` |

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
│   ├── init/                    ← /p-flow:init slash command
│   ├── task-start/              ← /p-flow:task-start slash command (Phase A + Phase B)
│   ├── task-end/                ← /p-flow:task-end slash command
│   ├── using-p-flow/            ← discovery skill (auto-emitted by hook)
│   ├── task-brainstorming/      ← spec authoring
│   ├── writing-plan/            ← plan authoring (TDD or generic)
│   ├── verification-before-completion/  ← test/lint gate before "done"
│   ├── test-driven-development/ ← RED-GREEN-REFACTOR enforcement before code
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
