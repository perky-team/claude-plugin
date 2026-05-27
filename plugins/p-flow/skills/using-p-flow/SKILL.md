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
| `/p-flow:init` | Bootstrap p-flow rules + templates + secret-deny-list into the current repo. One-time per repo. |
| `/p-flow:task-start <slug> [--worktree]` | Open a new task. Creates `<type>/<slug>` branch + `specs/<slug>/` dir + invokes brainstorming. |
| `/p-flow:task-end` | Finalize the task: pre-checks, push, recommend MR/PR. |

## Skills (model-invoked when context applies)

| Skill | Invoke when |
|---|---|
| `task-brainstorming` | User starts a new non-trivial task — auto-invoked by `task-start`, can also be called directly. |
| `writing-plan` | After a spec exists at `specs/<slug>/specification.md`. |
| `verification-before-completion` | Before ANY claim of "done", "fixed", "ready", or before any `git commit`. Non-negotiable. |
| `requesting-code-review` | After verification passes and there's a diff worth reviewing. Dispatches code-review via `Task` tool with `general-purpose` + inline template. |
| `requesting-task-review` | Same trigger; orthogonal lens — checks spec/plan alignment instead of code quality. Same dispatch pattern. |

## Hard rules

- **Verification is non-negotiable.** Never claim work is done without running `verification-before-completion`.
- **Reviews are read-only.** `requesting-*-review` skills dispatch reviewers that NEVER edit files; their output lands in `plan.md` as follow-ups.
- **plan.md sections are canonical.** `## Steps`, `## Review follow-ups — <date>`, `## Review decisions (audit)`, `## Open questions`, `## Risks` — don't rename, don't reorder.
- **Slug resolution.** Branches follow `<type>/<slug>` for `<type> ∈ {feature, bugfix, hotfix, chore, docs}`. Skills resolve `<slug>` from the branch name; if branch doesn't match, ask the user.

## Where to look for more

- Plugin README: `plugins/p-flow/README.md`
- Per-skill spec: `plugins/p-flow/skills/<name>/SKILL.md`
- Design history: `plugins/p-flow/docs/`
