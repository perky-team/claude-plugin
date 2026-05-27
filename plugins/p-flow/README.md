# p-flow

Disciplined task development flow for Claude Code: skills + subagents that walk a non-trivial task from idea, through spec and plan, to implementation and review, ending with a push and an MR recommendation. Plus repo-level workflow rules (secrets deny-list, Conventional Commits + `<type>/<slug>` branches, spec templates).

## Commands

| Command | Purpose |
|---|---|
| `/p-flow:init` | One-time per repo. Writes `.claude/settings.json` (secrets deny-list), `.claude/rules/p-flow.md` (rules), and `.claude/templates/p-flow/` (spec/feature/ADR templates). |
| `/p-flow:task-start <slug> [--worktree]` | Open a new task: ask branch type, create `<type>/<slug>` branch (and optional worktree), open `specs/<slug>/`, invoke brainstorming. |
| `/p-flow:task-end` | Finalize: pre-check the plan and verification marker, push the branch, recommend an MR with copy-ready `gh` and `glab` commands. |

## Skills (auto-invoked)

| Skill | When |
|---|---|
| `task-brainstorming` | Right after `/p-flow:task-start`. Produces `specs/<slug>/{specification.md, feature.feature?, adr.md?}`. |
| `writing-plan` | After spec is approved. Produces `specs/<slug>/plan.md` (5–15 steps, each with acceptance criteria). |
| `verification-before-completion` | Before any "done" claim or commit. Quotes test/lint output. Writes a state marker so `task-end` knows verification ran. |
| `requesting-code-review` | After verification passes. Dispatches `code-reviewer` subagent; triages findings into `plan.md` follow-ups. |
| `requesting-task-review` | Same trigger as code review, orthogonal lens. Dispatches `task-reviewer` subagent; checks spec/plan alignment. |

## Subagents

| Agent | Purpose | Tools |
|---|---|---|
| `code-reviewer` | Code-quality review of the branch diff. Returns findings by severity (blocker/suggestion/nit). | Read-only. |
| `task-reviewer` | Spec-alignment review: acceptance criteria, feature scenarios, plan-step coverage, scope creep. | Read-only. |

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
