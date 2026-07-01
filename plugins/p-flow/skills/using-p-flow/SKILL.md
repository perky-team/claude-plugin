---
name: using-p-flow
description: Use when starting any conversation in a repo with p-flow enabled — establishes the p-flow task development flow surface (commands, skills, when to invoke each) so the model can pick the right tool without keyword guessing.
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill.
</SUBAGENT-STOP>

<EXTREMELY-IMPORTANT>
If a p-flow skill clearly applies to what the user is asking (task setup, planning, verification, review, finishing), you MUST invoke it via the Skill tool before any other action.

User instructions (CLAUDE.md, AGENTS.md, direct request) ALWAYS take precedence over this skill. The user is in control.
</EXTREMELY-IMPORTANT>

# Using p-flow

p-flow ships a disciplined task development flow for Claude Code: brainstorm → plan → verify → review → push.

## Slash commands (user-triggered)

| Command | When user types it |
|---|---|
| `/p-flow:init` | Bootstrap p-flow into a new repo. Phase 1 — scaffold rules + templates + secret-deny-list. Phase 2 — brainstorm the initial feature list and create `specs/<slug>/specification.md` stubs. One-time per repo (state-machine guard; refuses if `specs/<slug>/` already exist). |
| `/p-flow:task-start <slug> [--worktree]` | Open a new task. Creates `<type>/<slug>` branch + `specs/<slug>/` dir + invokes brainstorming. |
| `/p-flow:task-end` | Finalize the task: pre-checks, push, recommend MR/PR. |

## Skills (model-invoked when context applies)

| Skill | Invoke when |
|---|---|
| `task-brainstorming` | User starts a new non-trivial task — auto-invoked by `task-start`, can also be called directly. |
| `writing-plan` | After a spec exists at `specs/<slug>/specification.md`. Offers a TDD-aligned template (default for code tasks) and a generic template (docs/research). |
| `executing-plan` | After the plan is approved and you're about to implement **inline in this session**. Drives the plan steps in order — TDD for code steps, verify after each, mark done only on green. Steps live in plan.md `## Steps` (legacy) or as p-tasks sub-tasks (canonical). The inline loop between `writing-plan` and `task-end`. |
| `subagent-driven-development` | After the plan is approved, when you want **per-step context isolation** instead of inline execution. Dispatches a fresh implementer subagent per step + a per-step review (spec + quality), broad review at the end. The isolated alternative to `executing-plan`; same p-tasks/checkbox ledger. |
| `test-driven-development` | Before writing any production code (functions / endpoints / classes / handlers / bugfix code). Enforces RED-GREEN-REFACTOR — failing test first, then minimal code, then verify. |
| `verification-before-completion` | Before ANY claim of "done", "fixed", "ready", or before any `git commit`. Non-negotiable. |
| `systematic-debugging` | When verification fails, a test goes red, or behaviour is unexpected — before proposing a fix. Reproduce → hypothesise → test → narrow → root-cause fix → re-verify. |
| `requesting-code-review` | After verification passes and there's a diff worth reviewing. Dispatches code-review via `Task` tool with `general-purpose` + inline template. |
| `requesting-task-review` | Same trigger; orthogonal lens — checks spec/plan alignment instead of code quality. Same dispatch pattern. |
| `receiving-code-review` | Before processing a review finding (a follow-up sub-task in canonical mode or a `## Review follow-ups` item in plan.md in legacy mode, a PR comment, a reviewer reply). Enforces verify-the-finding-first; reject false positives explicitly. |
| `using-git-worktrees` | Reference doc for safe worktree creation, pitfalls, cleanup. Useful background when `/p-flow:task-start --worktree` is invoked, or when isolating long-running work. |
| `writing-skills` | When authoring a new p-flow skill or substantially editing one — establishes frontmatter / section / dispatch conventions so the plugin stays internally consistent. |

## Hard rules

- **Verification is non-negotiable.** Never claim work is done without running `verification-before-completion`.
- **Reviews are read-only.** `requesting-*-review` skills dispatch reviewers that NEVER edit files; their triaged output lands as follow-ups — p-tasks sub-tasks in canonical mode, or `plan.md` `## Review follow-ups` in legacy mode.
- **plan.md sections are canonical (legacy mode).** When a `plan.md` exists (p-tasks absent), its sections `## Steps`, `## Review follow-ups — <date>`, `## Review decisions (audit)`, `## Open questions`, `## Risks` — don't rename, don't reorder. In canonical mode there is no plan.md.
- **Slug resolution.** Branches follow `<type>/<slug>` for `<type> ∈ {feature, bugfix, hotfix, chore, docs}`. Skills resolve `<slug>` from the branch name; if branch doesn't match, ask the user.
- **p-tasks is optional but canonical when present.** If (and only if) p-tasks is initialised in the repo (`docs/tasks/.ptasks.json` exists), it is the **single artifact** for the step list, statuses, review follow-ups, and the review audit — and there is **no `plan.md`** at all: `writing-plan` creates one sub-task per step (and a concise Overview in the parent task's description), `executing-plan` walks them, the review skills add follow-ups (and defer/reject audit) as sub-tasks, and `task-end` counts/closes them. The task narrative lives in `specs/<slug>/specification.md`. When p-tasks is **absent**, behaviour is byte-for-byte the legacy plan.md-only flow (`## Steps` checklist + `## Review follow-ups` + `## Review decisions (audit)` in plan.md). Creating real Jira issues still requires explicit confirmation.
- **p-wiki is optional.** If (and only if) p-wiki is initialised in the repo (`docs/wiki/.pwiki.json` exists), `task-brainstorming` offers to query prior knowledge before designing, and `task-end` offers to compile the task's decisions into the wiki. Never automatic, never silent, and absent entirely when p-wiki isn't installed.
- **p-graph is optional.** If (and only if) a code graph is initialised in the repo (`.pgraph/config.json` exists), `writing-plan` consults it during decomposition to find the change's impact set and fold downstream callers into `## Risks`. Read-only advisory (no offer prompt), deferring to the repo's `.claude/rules/p-graph.md` for the queries; absent entirely when p-graph isn't installed.
- **Prior-art consultation is opt-in and judgment-gated.** `task-brainstorming` may look up how a problem is commonly solved (prefer `context7` / `/deep-research`, else bounded `WebSearch`/`WebFetch`) and record a cited recommendation in `adr.md` — but **only** for approach/library/best-practice-sensitive tasks, never for routine work, never automatic, never a precondition. See `skills/_shared/prior-art-bridge.md`.

## Where to look for more

- Plugin README: `plugins/p-flow/README.md`
- Per-skill spec: `plugins/p-flow/skills/<name>/SKILL.md`
- Design history: `plugins/p-flow/docs/`
