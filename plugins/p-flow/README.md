# p-flow

Disciplined task development flow for Claude Code: skills + subagents that walk a non-trivial task from idea, through spec and plan, to implementation and review, ending with a push and an MR recommendation. Plus repo-level workflow rules (secrets deny-list, Conventional Commits + `<type>/<slug>` branches, spec templates).

## Commands

| Command | Purpose |
|---|---|
| `/p-flow:init` | Bootstrap p-flow into a new repo. Phase 1 — scaffold rules, templates, secret-deny-list. Phase 2 — brainstorm initial feature list with the user and create stub specs in `specs/<slug>/`. One-time per repo (state-machine guard). |
| `/p-flow:task-start <slug> [--worktree]` | Open a new task: ask branch type, create `<type>/<slug>` branch (and optional worktree), open `specs/<slug>/`, invoke brainstorming. |
| `/p-flow:task-end` | Finalize: pre-check the plan and verification marker, push the branch, recommend an MR with copy-ready `gh` and `glab` commands. |

## Discovery

p-flow ships a `SessionStart` hook (`hooks/hooks.json` + `hooks/session-start`) that surfaces the `using-p-flow` skill as a `<system-reminder>` whenever a Claude Code session starts, after `/clear`, and after auto-compaction. This is how Claude finds p-flow's surface without keyword guessing.

To disable: remove the `SessionStart` entry from `hooks/hooks.json`, or globally remove the plugin.

## Skills (invoked by commands or context)

| Skill | When |
|---|---|
| `using-p-flow` | Auto-emitted by the SessionStart hook on every fresh session / `/clear` / auto-compact. Establishes the p-flow surface for the model — lists commands, skills, hard rules. |
| `task-brainstorming` | Right after `/p-flow:task-start`. Produces `specs/<slug>/{specification.md, feature.feature?, adr.md?}`. |
| `writing-plan` | After spec is approved. Produces `specs/<slug>/plan.md` (5–15 steps, each with acceptance criteria). Offers a TDD-aligned template (default for code tasks) and a generic template (docs/research). |
| `executing-plan` | After `plan.md` is approved. Walks `## Steps` in order — invokes `test-driven-development` for code steps and `verification-before-completion` after each, checking off `- [x]` only on green. The execution loop between `writing-plan` and `task-end`. |
| `test-driven-development` | Before writing production code. Enforces RED-GREEN-REFACTOR (failing test first, minimal code, verify). Pairs with `verification-before-completion` ("before code" gate vs "before claiming done" gate). |
| `verification-before-completion` | Before any "done" claim or commit. Quotes test/lint output. Writes a state marker so `task-end` knows verification ran. |
| `systematic-debugging` | When verification fails or behaviour is unexpected, before proposing a fix. Reproduce → one falsifiable hypothesis → test it → narrow (bisect) → fix the root cause → re-verify. `executing-plan` routes here on a red step. |
| `requesting-code-review` | After verification passes. Dispatches `general-purpose` with the colocated `code-reviewer.md` template; triages findings into `plan.md` follow-ups. |
| `requesting-task-review` | Same trigger as code review, orthogonal lens. Dispatches `general-purpose` with the colocated `task-reviewer.md` template; checks spec/plan alignment. |
| `receiving-code-review` | Before processing review feedback (plan.md follow-ups, PR comments, reviewer replies). Verify the finding first; reject false positives with evidence. |
| `using-git-worktrees` | Reference doc for safe worktree creation, pitfalls, cleanup. Background for `--worktree` flow + long-running isolation. |
| `writing-skills` | Authoring a new p-flow skill or substantially editing one — frontmatter / section / dispatch / template / test conventions. |

## Reviewer templates

The `requesting-code-review` and `requesting-task-review` skills dispatch the **`general-purpose`** subagent via the `Task` tool, inlining a reviewer prompt template from the skill's own directory:

| Template | Used by | Purpose |
|---|---|---|
| [`skills/requesting-code-review/code-reviewer.md`](./skills/requesting-code-review/code-reviewer.md) | `requesting-code-review` | Code-quality review of the branch diff. Returns findings by severity (blocker / suggestion / nit). Read-only. |
| [`skills/requesting-task-review/task-reviewer.md`](./skills/requesting-task-review/task-reviewer.md) | `requesting-task-review` | Spec-alignment review: acceptance criteria, feature scenarios, plan-step coverage, scope creep. Read-only. |

This pattern (inline templates rather than registered subagents) means the review skills work in any Claude Code session — no plugin install required at the target.

## Integration with p-tasks (optional)

If the [`p-tasks`](../p-tasks/) tracker is initialised in the same repo (detected by `docs/tasks/.ptasks.json`), it becomes the **single canonical store** for the task/step list and statuses — eliminating the old duplication where the step list lived both in `plan.md` and in p-tasks. plan.md then keeps only the narrative that was never a work item (`## Risks`, `## Open questions`, `## Review decisions (audit)`); the `## Steps` checklist is gone.

| Skill | Behaviour when p-tasks is present |
|---|---|
| `writing-plan` | Creates a p-tasks `task` named `<slug>` plus one `sub-task` per plan step (with `acceptance` / `files` / `kind` / `origin plan`), and writes a slim plan.md with **no `## Steps`**. |
| `executing-plan` | Walks `p-tasks:list <parent>` in document order, classifies each by `kind`, verifies, and marks each done — no plan.md checkbox edits. |
| `requesting-code-review` / `requesting-task-review` | Each accepted finding becomes a `sub-task` with `origin code-review:<severity>` / `task-review:<severity>`; defer/reject still log to plan.md `## Review decisions (audit)`. |
| `receiving-code-review` | Fix → implement then mark the sub-task done; reject → `set --status done --resolution "<reason>"`. |
| `task-end` | Completeness count = not-done sub-tasks; "What changed" = done sub-task titles; on finalize, close the parent and every remaining sub-task explicitly. |

This is a **soft, one-way** integration: p-flow knows about p-tasks, not the reverse, and there is **no plugin-manifest dependency** — each plugin installs and runs standalone. When p-tasks is **absent**, behaviour is byte-for-byte the legacy plan.md-only flow (the `## Steps` checklist). The bridge dispatches through the Skill tool (`p-tasks:add` / `p-tasks:set` / `p-tasks:list` / `p-tasks:summary` / `p-tasks:next`), never p-tasks' CLI, so it respects per-plugin isolation. Driving an `fs` store is part of the normal flow; creating or updating real Jira issues warns first and proceeds only on an explicit yes. Contract: `skills/_shared/ptasks-bridge.md`.

## Integration with p-wiki (optional)

If the [`p-wiki`](../p-wiki/) knowledge base is initialised in the same repo (detected by `docs/wiki/.pwiki.json`), p-flow offers two opt-in points — read knowledge in, write knowledge out:

| Skill | Offer |
|---|---|
| `task-brainstorming` | Before designing — query the wiki for prior decisions/patterns about the task area, and flag any conflict with accumulated knowledge. |
| `task-end` | After the MR recommendation — compile the task's durable decisions (`specs/<slug>/adr.md`, else `specification.md`) into wiki pages. |

Same **soft, one-way** contract as the p-tasks bridge: no plugin-manifest dependency, dispatch through the Skill tool (`p-wiki:query` / `p-wiki:compile`) rather than p-wiki's CLI, offers never silent, absent entirely when p-wiki isn't installed. Capture uses `compile` (not `ingest`, which refuses in-repo paths) and warns before publishing to Confluence Cloud. Contract: `skills/_shared/pwiki-bridge.md`.

## Integration with p-graph (optional)

If the [`p-graph`](../p-graph/) code knowledge graph is initialised in the same repo (detected by `.pgraph/config.json`), `writing-plan` consults it during decomposition:

| Skill | Use |
|---|---|
| `writing-plan` | When the spec touches existing code — find the change's impact set (downstream callers/callees), let it inform step granularity, and record notable affected modules under the plan's `## Risks` section. |

This bridge is **advisory and read-only** — unlike the p-tasks/p-wiki bridges it makes no offer and writes nothing. p-graph exposes no query skill (its structural queries are CLI commands), and `/p-graph:init` already installs a repo rule (`.claude/rules/p-graph.md`) that tells the model how to query the graph. So p-flow only **points** the model at the graph at the right moment and defers the actual commands to that installed rule — keeping p-flow uncoupled from p-graph's pre-1.0 CLI. The one stateful action, refreshing a stale graph, goes through the Skill tool (`p-graph:sync`). Contract: `skills/_shared/pgraph-bridge.md`.

## What `/p-flow:init` writes

In the current git repo (or current working directory if not a git repo):

- `.claude/settings.json` — `permissions.deny` patterns blocking reads/writes of common secret-bearing files (`.env*`, `*.pem`, `*.key`, `*credentials*`, `*secrets*`, SSH/AWS dotdirs, etc.). Merged if the file already exists.
- `.claude/rules/p-flow.md` — security guidance, Git workflow (Conventional Commits + `feature/<slug>` / `bugfix/<slug>` / `hotfix/<slug>` / `chore/<slug>` / `docs/<slug>`), specifications layout, and a §4 describing the skill flow.
- `.claude/templates/p-flow/` — three template files (`adr.md`, `feature-spec.feature`, `specification.md`).
- `specs/<slug>/specification.md` — one stub per feature agreed during Phase 2's brainstorm dialog (skippable). Each stub fills metadata + problem + user story + 1–3 acceptance bullets; the rest stays as `{{PLACEHOLDERS}}` for `task-brainstorming` to resume later via `/p-flow:task-start <slug>`.

### Idempotency

`/p-flow:init` uses a state-machine guard based on what's already on disk:

| `.claude/rules/p-flow.md` | `specs/<slug>/` folders | Behaviour |
|---|---|---|
| missing | none | runs both phases (scaffolding + brainstorm) |
| present | none | skips scaffolding, runs brainstorm only (resume interrupted dialog) |
| present | ≥ 1 | refuses — already initialised; use `/p-flow:task-start` to add new features, or delete `.claude/rules/p-flow.md` AND the `specs/<slug>/` folders manually to regenerate |
| missing | ≥ 1 | refuses — inconsistent state; restore `.claude/rules/p-flow.md` (e.g. via git) or remove the orphaned `specs/<slug>/` folders, then re-run |

## Spec directory layout

After `task-brainstorming` and friends, each task lives in:

```
specs/<slug>/
├── specification.md      ← always
├── feature.feature       ← if behavioral scenarios exist
├── adr.md                ← if an architectural decision is needed
└── plan.md               ← written by writing-plan; review follow-ups appended after each review
```

The `plan.md` file uses one of two templates from `_shared/templates/` — `plan-tdd.template.md` for code tasks (default) or `plan-generic.template.md` for docs/research. `writing-plan` asks the user which to use.

## More

- `CLAUDE.md` — contributor guide (architecture decisions, conventions, test invariants, where things live).
- `RELEASE-NOTES.md` — per-version changelog.

## Known limitations

- **Reviewer scope-discipline is best-effort.** `code-reviewer` and `task-reviewer` ship with strict negative-scope rules + a final self-check pass, but the line between code quality and spec alignment isn't always crisp. In practice, on Sonnet the two reports may have ~20% topical overlap (e.g. `code-reviewer` may surface a plan/impl mismatch as a *Suggestion* with a self-noted "doc consistency" caveat). Read both reports as potentially complementary rather than strictly orthogonal.
- **Sonnet or stronger is required for review agents.** Weaker models (e.g. Haiku) do not reliably honour the scope-discipline directives — they tend to ignore the negative-scope rule entirely and emit cross-domain findings. The agent frontmatter declares `model: sonnet`; if you fork and downgrade, expect noisier reports.
- **No automated validation of reviewer-template behaviour.** Structural invariants (template exists + has `## What is NOT your scope`) are covered by `tests/review-template-refs.test.ts`. Behavioural compliance is validated by the manual smoke test in `docs/plans/2026-05-27-task-flow-followups.md` and re-runs whenever a reviewer template changes.

## Install

```text
/plugin marketplace add perky-team/claude-plugin
/plugin install p-flow@perky.team
```

Then in any repo:

```text
/p-flow:init        # one-time
/p-flow:task-start my-feature-slug
```
