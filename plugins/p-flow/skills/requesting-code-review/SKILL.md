---
name: requesting-code-review
description: Use after `verification-before-completion` passes and there is a diff worth reviewing. Dispatches a code-review subagent (via Task tool with `general-purpose` + inline template) on the branch diff, then leads the user through severity-aware triage and records accepted findings as follow-ups — p-tasks sub-tasks in canonical mode, or `plan.md` steps in legacy mode.
allowed-tools: Bash(git diff:*) Bash(git status:*) Bash(git log:*) Bash(git rev-parse:*) Bash(git merge-base:*) Bash(git remote:*) Bash(grep:*) Bash(test:*) Read Write Edit Glob Task Skill
---

# requesting-code-review

Run a code-quality review on the current branch's diff, triage the findings, and record accepted findings as follow-ups (p-tasks sub-tasks in canonical mode, or `plan.md` steps in legacy mode).

**Announce at start:** *"I'm using the `requesting-code-review` skill to run a code-quality review on the branch diff."*

## Mode gate

Before precondition 3 and before triage, run the gate in `${CLAUDE_SKILL_DIR}/../_shared/noninteractive.md`. It resolves one of two modes and nothing else:

- **Interactive** (the default — `P_FLOW_NONINTERACTIVE` unset or not exactly `1`): everything below runs as written, questions and all. The gate is a silent no-op; do not mention it.
- **Non-interactive** (`P_FLOW_NONINTERACTIVE=1`): the two blocks marked **Non-interactive** below replace the questions they sit next to. Nothing else in this skill changes.

## Preconditions

1. **Resolve the base branch** for the diff: try `main` first, then `master`. If neither exists locally → run `git remote show origin | grep 'HEAD branch'` to read the remote's default; use that. If that also fails → ask the user for the base branch name. Call the result `<base>`.
2. There is a diff to review. Check: `git diff <base>...HEAD` shows non-empty output. If empty — say: *"No diff to review. Run after implementing some steps."*
3. `specs/<slug>/specification.md` exists. Determine `<slug>` from the current branch name (strip the `<type>/` prefix) or ask the user. Run the p-tasks gate in `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md` to fix the mode: **legacy mode** (p-tasks absent) additionally requires `specs/<slug>/plan.md`; **canonical mode** (p-tasks present) has no `plan.md` and uses the `<slug>` p-tasks task instead.

### Non-interactive — precondition 3 only

In non-interactive mode there is nobody to name a slug or author a spec, so this precondition is replaced:

- **p-tasks present (canonical mode)** → the `specs/<slug>/specification.md` requirement is **dropped**, and the parent p-tasks task is resolved by the order below — **never from the branch name**. A headless caller is an autonomous loop: it lives on ONE long-lived branch and takes whichever task `p-tasks:next` hands it, so the branch names the *worker*, not the task. On `auto/dev` the branch would yield the slug `dev`, and no task is titled `dev` — which is why every headless run stopped here. Resolve `<parent>` in this order:

  1. **The skill's argument — `--task <t-id|task-title>`.** This is the intended path: the caller has just taken the task from `p-tasks:next`, knows which one it is working on, and writes that argument into the prompt by hand. The value is either the p-tasks **task id** (`t-7`) or the task's **exact title** (`fix-worker-retry` — which the bridge's join key makes exactly the `<slug>`). Resolve it against the whole-project listing — via the Skill tool, `p-tasks:list` with no argument — matching a top-level `task` by `id` or by exact `title`. If nothing matches, **stop** — *"p-flow: non-interactive mode cannot resolve the parent task — `--task <value>` matches no p-tasks task."* An argument that matches nothing **never falls through** to step 2: the caller named a task, and reviewing a different one is worse than stopping.

  2. **Fallback — the single `in_progress` task.** With no argument, take from that same listing the top-level `task` items whose `status` is `in_progress`. Use it only when there is **exactly one**; that one is `<parent>`. Two or more is ambiguous and **must not be guessed** at — a live deployment currently has three.

  3. **Otherwise stop**, naming which of the two inputs was missing, because the operator's fix differs:
     - nothing in progress → *"p-flow: non-interactive mode cannot resolve the parent task — no `--task` argument was given and no task is `in_progress`."*
     - two or more → *"p-flow: non-interactive mode cannot resolve the parent task — no `--task` argument was given and <N> tasks are `in_progress`: <ids and titles>."*

  `<slug>` is then the resolved `<parent>`'s title — `_shared/ptasks-bridge.md` defines a top-level task's title as being **exactly** the slug — and the rest of this skill uses `<parent>` / `<slug>` unchanged. Never guess a slug, and never derive one from the branch name.

- **p-tasks present with a `jira` primary or mirror** → **stop** — *"p-flow: non-interactive mode cannot confirm Jira writes — the p-tasks destination is `jira`."* The bridge requires an explicit yes before creating real issues and there is nobody to give it. Checking this here, before the reviewer is dispatched, keeps a headless run from burning a review it may not record.
- **p-tasks absent** → **stop** — *"p-flow: non-interactive mode requires p-tasks (canonical mode) — `docs/tasks/.ptasks.json` not found."* Do not fall back to legacy: legacy mode has no place to record the triage outcomes without a `plan.md` this run cannot verify a human authored.

## Procedure

### 1. Compose the brief for `code-reviewer`

Capture:

- **Goal**: one paragraph distilled from `specification.md` "Overview / Problem Statement / Proposed Solution".
  - **Non-interactive + canonical mode**: `specification.md` may not exist. Compose the Goal from the parent p-tasks task's `description` — the concise Overview `writing-plan` puts there — read from the whole-project listing already used to resolve `<parent>` (Skill tool, `p-tasks:list` with **no** argument; a listing scoped to `<parent>` returns that task's sub-tasks, not the task itself). If the spec file does happen to exist, prefer it, exactly as above.
- **What was done**: the list of completed steps.
  - **Legacy mode** (p-tasks absent — run the gate in `${CLAUDE_SKILL_DIR}/../_shared/ptasks-bridge.md`): the checked items under `## Steps` in `plan.md` (do not include follow-ups or audit entries).
  - **Canonical mode** (p-tasks present): the done sub-tasks of the `<slug>` task — via the Skill tool, `p-tasks:summary <parent>` (which returns done items only). There is no plan.md in this mode.
- **Focus areas**: by default — correctness, security, dead code, style consistency. If the user requested specific focus, prepend it.
- **Diff command**: `git diff $(git merge-base <base> HEAD)...HEAD` where `<base>` is the branch resolved in precondition 1. Use `git rev-parse --abbrev-ref HEAD` to know the current branch.

### 2. Dispatch the agent

Use the Task tool with `subagent_type: general-purpose`. The prompt MUST be assembled in this order:

1. Read the template at `${CLAUDE_SKILL_DIR}/code-reviewer.md` (the file colocated with this SKILL.md) and inline its full content verbatim at the top of the prompt.
2. Append a `---` separator and then a `## Brief` section containing the goal, what-was-done, focus areas, diff command, and the spec/plan paths composed above:
   - **Legacy mode:** the literal paths to both `specification.md` and `plan.md`.
   - **Canonical mode:** only the path to `specification.md` (there is no `plan.md` — do not pass one; the reviewer works from the spec and the diff).
   - **Non-interactive + canonical mode with no `specification.md`:** pass no path at all; the reviewer works from the brief and the diff. Do not point it at a file that does not exist.

This dispatches `general-purpose` with code-reviewer instructions — works whether or not the p-flow plugin is installed in the target session.

### 3. Receive findings

The agent returns a structured Markdown report with `### Blockers`, `### Suggestions`, `### Nits`. Show it to the user verbatim before triage.

### 4. Triage protocol (explicit — avoids AskUserQuestion 4-option limit)

For each severity, follow exactly this protocol:

- **Blockers**: one at a time. For each, ask the user with three options: `fix` / `defer` / `reject`. If `defer` or `reject` — require a one-line reason. No defaults — user must answer.

- **Suggestions**: present as a numbered list (up to 10 per batch). Ask the user once: *"Reply with comma-separated indices to fix (e.g. `1,3,5`), or `all`, or `none`. Items not selected default to `defer` with reason 'not selected'. You may add explicit reject reasons inline like `2:reject (false positive: X)`."*

- **Nits**: present as a numbered list. Ask once: *"Reply with comma-separated indices to opt-in for fixing, or `none`. Default action is `reject all` with reason 'nit declined'."*

#### Non-interactive triage policy

In non-interactive mode the three protocols above **do not run** — none of their prompts is emitted and none of their defaults applies. This fixed policy replaces them:

| Severity | Decision | Recorded as (§5) |
|---|---|---|
| Blocker | `fix` | accepted finding — an open `code-review:blocker` follow-up sub-task |
| Suggestion | `fix` | accepted finding — an open `code-review:suggestion` follow-up sub-task |
| Nit | `defer`, reason `nit declined (non-interactive default)` | deferred finding — a done `code-review:nit` sub-task carrying that `--resolution` |

`fix` means here what it means above: the finding becomes a follow-up work item. This skill still fixes nothing itself — `receiving-code-review` picks the sub-tasks up and verifies each finding before implementing it.

`reject` is **unavailable** in non-interactive mode. Rejecting a finding asserts that the reviewer was wrong, and that judgement is reserved for a human. Nothing is dropped as a consequence: every finding the reviewer emitted lands in p-tasks with a decision attached, and the run records no rejections at all.

Record these decisions with the §5 **canonical mode** calls exactly as written there — same command, same fields — so the audit trail has the same shape as a human's.

### 5. Record the triage outcomes

**Accepted findings (`fix`):**

- **Legacy mode:** append a new `[ ]` step in the `## Review follow-ups — <YYYY-MM-DD>` section of `plan.md`. Continue the existing step numbering (never restart). If the section for today's date does not exist — create it just after `## Steps`. Each follow-up:

  ```markdown
  N. [ ] Fix: <short summary> (code-review, <severity>)
     - **Acceptance**: <derived from the agent's suggested fix>
  ```

- **Canonical mode:** via the Skill tool, `p-tasks:add sub-task <parent>` with `--title "Fix: <short summary>"`, `--origin code-review:<severity>`, `--acceptance "<derived from the agent's suggested fix>"`, and `--files "<comma list>"` when known. The follow-up is now a sub-task alongside the plan steps — no `plan.md` exists to hold a `## Review follow-ups` section. (If the destination is `jira`, warn per the bridge doc before creating issues.)

**Deferred / rejected findings:**

- **Legacy mode** → append a bullet to `## Review decisions (audit)` in `plan.md` (create the section just before `## Open questions` if missing). This narrative audit log lives in plan.md:

  ```markdown
  - code-review <severity> "<short summary>" — **<deferred|rejected>**: <reason>
  ```

- **Canonical mode** → the audit lives in p-tasks, not a `plan.md`. Via the Skill tool, `p-tasks:add sub-task <parent>` with `--title "<short summary>"`, `--origin code-review:<severity>`, `--status done`, and `--resolution "deferred: <reason>"` / `"rejected: <reason>"`. The done sub-task carrying a `resolution` **is** the audit entry — never create or write to `plan.md`. (Warn per the bridge doc before creating Jira issues.)

### 6. Close the loop

Tell the user the new follow-ups (legacy: the new `## Review follow-ups` step numbers; canonical: the new `code-review:*` sub-task ids/titles) and: *"When ready to fix, say 'continue' and pick them up via `receiving-code-review` (it verifies each finding before implementing or rejecting)."*

## What this skill does NOT do

- Does not push, tag, or create MRs (that's `task-end`).
- Does not run the agent on uncommitted changes if the user wants a *committed* review — by default it reviews `merge-base...HEAD`, which includes committed work only. If the user wants to include unstaged changes, switch to `git diff HEAD` and tell the user explicitly.
- Does not fix anything itself.
