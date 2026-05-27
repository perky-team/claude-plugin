# p-flow

Disciplined task development flow for Claude Code: skills + subagents that walk a non-trivial task from idea, through spec and plan, to implementation and review, ending with a push and an MR recommendation. Plus repo-level workflow rules (secrets deny-list, Conventional Commits + `<type>/<slug>` branches, spec templates).

## Commands

| Command | Purpose |
|---|---|
| `/p-flow:init` | One-time per repo. Writes `.claude/settings.json` (secrets deny-list), `.claude/rules/p-flow.md` (rules), and `.claude/templates/p-flow/` (spec/feature/ADR templates). |
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
| `writing-plan` | After spec is approved. Produces `specs/<slug>/plan.md` (5–15 steps, each with acceptance criteria). |
| `verification-before-completion` | Before any "done" claim or commit. Quotes test/lint output. Writes a state marker so `task-end` knows verification ran. |
| `requesting-code-review` | After verification passes. Dispatches `general-purpose` with the colocated `code-reviewer.md` template; triages findings into `plan.md` follow-ups. |
| `requesting-task-review` | Same trigger as code review, orthogonal lens. Dispatches `general-purpose` with the colocated `task-reviewer.md` template; checks spec/plan alignment. |

## Reviewer templates

The `requesting-code-review` and `requesting-task-review` skills dispatch the **`general-purpose`** subagent via the `Task` tool, inlining a reviewer prompt template from the skill's own directory:

| Template | Used by | Purpose |
|---|---|---|
| [`skills/requesting-code-review/code-reviewer.md`](./skills/requesting-code-review/code-reviewer.md) | `requesting-code-review` | Code-quality review of the branch diff. Returns findings by severity (blocker / suggestion / nit). Read-only. |
| [`skills/requesting-task-review/task-reviewer.md`](./skills/requesting-task-review/task-reviewer.md) | `requesting-task-review` | Spec-alignment review: acceptance criteria, feature scenarios, plan-step coverage, scope creep. Read-only. |

This pattern (inline templates rather than registered subagents) means the review skills work in any Claude Code session — no plugin install required at the target.

## What `/p-flow:init` writes

In the current git repo (or current working directory if not a git repo):

- `.claude/settings.json` — `permissions.deny` patterns blocking reads/writes of common secret-bearing files (`.env*`, `*.pem`, `*.key`, `*credentials*`, `*secrets*`, SSH/AWS dotdirs, etc.). Merged if the file already exists.
- `.claude/rules/p-flow.md` — security guidance, Git workflow (Conventional Commits + `feature/<slug>` / `bugfix/<slug>` / `hotfix/<slug>` / `chore/<slug>` / `docs/<slug>`), specifications layout, and a §4 describing the skill flow.
- `.claude/templates/p-flow/` — three template files (`adr.md`, `feature-spec.feature`, `specification.md`).

### Idempotency

`/p-flow:init` refuses if `.claude/rules/p-flow.md` already exists. To reinitialise, delete that file and re-run.

## Spec directory layout

After `task-brainstorming` and friends, each task lives in:

```
specs/<slug>/
├── specification.md      ← always
├── feature.feature       ← if behavioral scenarios exist
├── adr.md                ← if an architectural decision is needed
└── plan.md               ← written by writing-plan; review follow-ups appended after each review
```

## Known limitations

- **Reviewer scope-discipline is best-effort.** `code-reviewer` and `task-reviewer` ship with strict negative-scope rules + a final self-check pass, but the line between code quality and spec alignment isn't always crisp. In practice, on Sonnet the two reports may have ~20% topical overlap (e.g. `code-reviewer` may surface a plan/impl mismatch as a *Suggestion* with a self-noted "doc consistency" caveat). Read both reports as potentially complementary rather than strictly orthogonal.
- **Sonnet or stronger is required for review agents.** Weaker models (e.g. Haiku) do not reliably honour the scope-discipline directives — they tend to ignore the negative-scope rule entirely and emit cross-domain findings. The agent frontmatter declares `model: sonnet`; if you fork and downgrade, expect noisier reports.
- **No automated validation of agent prompt behaviour.** Structural invariants (read-only `tools:`, presence of `## What is NOT your scope`, severity model consistency) are covered by `tests/agents.test.ts`. Behavioural compliance is validated by the manual smoke test in `docs/plans/2026-05-27-task-flow-followups.md` and re-runs whenever a review agent's prompt changes.

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
