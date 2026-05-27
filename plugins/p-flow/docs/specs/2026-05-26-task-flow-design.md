# Design — p-flow task flow (skills + agents)

| Field      | Value                                             |
|------------|---------------------------------------------------|
| Status     | Draft (pending user approval)                     |
| Date       | 2026-05-26                                        |
| Author     | Andrey Sukharev                                   |
| Slug       | `p-flow-task-flow`                                |
| Plugin     | `plugins/p-flow`                                  |

---

## 1. Overview

### Problem statement

The current `p-flow` plugin ships a single slash command (`/p-flow:init`) that scaffolds repo-level
artifacts: a deny-list for secrets, Conventional Commits + branch rules, and three specification
templates. It is purely artifactual — it sets up *files*, not *behavior*. There are no skills, no
agents, no enforced workflow.

We want to evolve `p-flow` into a plugin that provides a complete **task development flow**: skills
and agents that walk a task from idea, through spec and plan, to implementation and review, ending
with a push and an MR recommendation. The new `p-flow` replaces the user's reliance on the public
`superpowers` plugin with a leaner, domain-extensible alternative.

### Proposed solution

A layered architecture:

1. **Slash commands** as workflow entry/exit points: `/p-flow:task-start <slug>`,
   `/p-flow:task-end`. The existing `/p-flow:init` stays.
2. **Skills** for each phase of the flow: `task-brainstorming`, `writing-plan`,
   `verification-before-completion`, `requesting-code-review`, `requesting-task-review`.
3. **Subagents** for read-only, isolated review jobs: `code-reviewer`, `task-reviewer`.
4. **Repo-level artifacts** (already produced by `/p-flow:init`) serve as the templates and rules
   that the skills reference. Skills work without `init` (inline fallback), but work better with it.

### User story

> As a developer using Claude Code, I want a disciplined, repeatable flow for any non-trivial task
> — from initial idea to merged work — that produces durable artifacts (spec, plan, reviews) and
> enforces verification at every step, without me having to remember to ask for it each time.

---

## 2. Goals and non-goals

### Goals

- Provide a complete, dev-flavored task flow that replaces the public `superpowers` plugin for the
  user's workflow.
- Keep `/p-flow:init` and its three templates as the canonical sources of truth for spec structure.
- Make every "done" claim cheap to verify by enforcing `verification-before-completion`.
- Separate **code quality** review (`code-reviewer`) from **spec alignment** review
  (`task-reviewer`) — two orthogonal lenses, two agents.
- Treat review findings as plan items, not silent fixes — preserve audit trail and discipline.
- Stay architecturally open for adjacent domains (QA test design, DevOps runbooks) without
  building those domains in MVP.

### Non-goals

- Replicate every skill from `superpowers`. We pick what we need.
- Bake type-of-work (`feature` / `bugfix` / `tech-task` / ...) into a first-class enum inside the
  brainstorm skill. One flexible skill, one flexible template; type only affects branch prefix.
- Build QA or DevOps domain skills in MVP. Architecture supports them as Wave 2+.
- Auto-merge, auto-tag, auto-PR creation. The flow stops at "push + MR recommendation".
- Estimation (hours / days / story points).
- Pre-commit hooks, CI integration, or any out-of-session enforcement.

---

## 3. Architecture

### Layers

```
┌──────────────────────────────────────────────────────────────┐
│ Slash commands (entry/exit points)                           │
│   /p-flow:init                          (existing)           │
│   /p-flow:task-start <slug> [--worktree]   (new, MVP)        │
│   /p-flow:task-end                         (new, MVP)        │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│ Skills (behavior, activated by commands and context)         │
│   MVP:                                                       │
│     task-brainstorming                                       │
│     writing-plan                                             │
│     verification-before-completion                           │
│     requesting-code-review                                   │
│     requesting-task-review                                   │
│   Wave 2:                                                    │
│     executing-plan                                           │
│     systematic-debugging                                     │
│     qa-brainstorming                                         │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│ Subagents (isolated, read-only review jobs)                  │
│   code-reviewer       (used by requesting-code-review)       │
│   task-reviewer       (used by requesting-task-review)       │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│ Repo-level artifacts (optional, produced by /p-flow:init)    │
│   .claude/rules/p-flow.md          — rules                   │
│   .claude/templates/p-flow/*       — spec / feature / ADR    │
│   .claude/settings.json            — secrets deny-list       │
│   specs/<slug>/                    — task artifacts          │
└──────────────────────────────────────────────────────────────┘
```

### Responsibility boundaries

- **Slash commands** — coordination only. Create branch, optionally worktree, hand off to skill,
  finalize on end. No design/planning logic in commands.
- **Skills** — *what* and *how* in each phase. Skills may suggest the next skill, but the user can
  pause between phases and resume later via slash commands.
- **Agents** — isolated one-shot jobs (review, audit), invoked by skills with a focused brief.
- **Repo artifacts** — optional. Skills work without `init` by falling back to inline templates,
  but `init`-produced templates are preferred when present.

### Key architectural decision: skills are not init-dependent

Every skill that needs a template or rule:

1. Checks for the file under `.claude/templates/p-flow/` or `.claude/rules/p-flow.md`.
2. If present — uses it.
3. If absent — uses an inline fallback shipped with the skill, and tells the user:
   *"Run `/p-flow:init` for a repo-wide canonical template."*

This makes the plugin useful immediately after install. `init` is an upgrade, not a prerequisite.

### Key architectural decision: brainstorm skills are per-domain

Each domain (dev / QA / DevOps) has its own brainstorming skill — they share *form* (dialog,
self-review, user gate, hand-off to `writing-plan`) but not *content* (questions, output artifact
structure). This keeps single-responsibility clean and avoids a kitchen-sink skill.

MVP ships only `task-brainstorming` (dev). Wave 2 adds `qa-brainstorming`. DevOps remains a
theoretical extension point and is documented but not implemented.

### Key architectural decision: reviewers are read-only

`code-reviewer` and `task-reviewer` agents have only `Read`, `Glob`, `Grep`, `Bash(git diff:*)`.
They cannot edit files. Findings become new steps in `plan.md` (after user triage), which then
flow through the normal `executing-plan` discipline. This preserves:

- Audit trail (review file/section shows what was found and how it was triaged).
- Discipline (every fix goes through `verification-before-completion`).
- Role separation (reviewer ≠ implementer).

### Key architectural decision: reviewers are CI-friendly by construction

Both `code-reviewer` and `task-reviewer` agents are designed to be usable in two contexts without
modification:

- **Interactive (in-session)** — invoked by `requesting-code-review` / `requesting-task-review`
  skills. Triage happens with the user. This is the MVP path.
- **Non-interactive (CI)** — invoked by a future `ci-mr-review` skill (Wave 3, see §9). No user,
  no triage; output goes to stdout / MR comments; exit code maps to blocker presence.

This puts a constraint on every agent prompt: **the agent body must never assume a human is on
the other end**. Specifically, no "ask the user", no "wait for clarification", no interactive
prompts inside the agent. Agents take a brief and produce a deterministic report. Triage and
human dialog live outside agents, in the requesting skill.

A second consequence — **the *caller* decides whether to dispatch `task-reviewer`**, not the
agent itself. `task-reviewer` continues to require a spec path in its brief (no "no-spec" branch
inside the agent). Callers that may not have a spec — notably `ci-mr-review` — detect the
absence and simply skip the task-review dispatch. This keeps the agent's prompt focused and
deterministic; the conditional logic lives in skills, where it belongs.

### Plugin file layout

The plugin lives entirely under `plugins/p-flow/`. After Wave 1 the layout is:

```
plugins/p-flow/
├── .claude-plugin/
│   └── plugin.json
├── README.md
├── skills/
│   ├── _shared/
│   │   └── templates/                       ← existing (source templates for init)
│   ├── init/
│   │   └── SKILL.md                         ← existing /p-flow:init
│   ├── task-start/
│   │   └── SKILL.md                         ← new /p-flow:task-start
│   ├── task-end/
│   │   └── SKILL.md                         ← new /p-flow:task-end
│   ├── task-brainstorming/
│   │   └── SKILL.md
│   ├── writing-plan/
│   │   └── SKILL.md
│   ├── verification-before-completion/
│   │   └── SKILL.md
│   ├── requesting-code-review/
│   │   └── SKILL.md
│   └── requesting-task-review/
│       └── SKILL.md
├── agents/
│   ├── code-reviewer.md
│   └── task-reviewer.md
└── docs/
    ├── specs/                               ← this document lives here
    └── plans/                               ← implementation plans
```

**Slash commands are skills.** In this repo's plugin convention (see `p-wiki`, `p-tasks`,
`p-statusline`, and the existing `p-flow:init`), every `/p-flow:<name>` is realized by
`skills/<name>/SKILL.md`. There is no separate `commands/` directory. A skill becomes a
discoverable slash command by virtue of its `name:` frontmatter — typing `/p-flow:<name>`
invokes the skill body directly. The skill body still uses the Skill tool internally to invoke
*other* skills when it needs to hand off (e.g. `task-start` invokes `task-brainstorming`).

This means the prior distinction between "slash command" and "skill" in this document is one of
*role and naming*, not of file layout: `task-start` and `task-end` are orchestration skills
named to read as commands; the other skills are behavior skills.

Skill folders follow the standard Claude Code skill layout: `SKILL.md` with frontmatter
(name, description, optionally `argument-hint`, optionally `allowed-tools`) and a body that
defines behavior.

Agent files in `agents/*.md` follow the standard subagent layout: frontmatter with name,
description, and tool whitelist, plus a body that defines the agent's behavior.

The `_shared/templates/` folder is the **single source of truth** for spec/feature/adr templates.
Both `init` and `task-brainstorming` read from it via `${CLAUDE_SKILL_DIR}/../_shared/templates/`:

- `init` *copies* templates into the user's repo at `.claude/templates/p-flow/`.
- `task-brainstorming` first checks `.claude/templates/p-flow/<file>` in the repo (so the team's
  customized template takes precedence); if absent, falls back to reading the same file from the
  plugin's `_shared/templates/`. No template duplication inside skill folders.

---

## 4. Components

### 4.1 Slash command `/p-flow:init` — unchanged

Already exists. Composition of templates and rules-template is **unchanged** in this design.

The `rules-p-flow.template.md` *content* gains one new section (`## 4. Skills and flow`) describing
the new skills and slash commands. This is backwards-compatible — old repos that were initialized
before this update don't get the section automatically, and skills don't depend on it being there.

### 4.2 Slash command `/p-flow:task-start <slug> [--worktree]` — new

Entry point to the task flow.

**Arguments:**

- `<slug>` — kebab-case, lowercase, ≤ 50 chars. Required. If omitted — slash command asks.
- `--worktree` — optional flag. If present, creates a git worktree at `<repo-parent>/<repo-dir>-<slug>`
  checked out to the new branch. (`<repo-dir>` = basename of `git rev-parse --show-toplevel`.)

**Behavior:** the slash command performs all read-only preconditions and user prompts first,
resolves the full plan (branch name, worktree path, spec dir), and only then executes side effects
atomically. This avoids half-applied state when a conflict is discovered late.

**Phase A — preconditions and resolution (no side effects):**

1. Verify the current directory is a git repo. If not — stop with `git init` suggestion.
2. Verify working tree is clean. If dirty — refuse, ask user to commit or stash.
3. Ask the user for **branch type** (`feature` / `bugfix` / `hotfix` / `chore` / `docs`). This
   determines the branch prefix only — it does not select a different spec template (Variant B).
   If a strong hint is present in the conversation, suggest the most likely choice with override.
4. Compute target branch name `<type>/<slug>`, target spec dir `specs/<slug>/`, and (if
   `--worktree`) target worktree path `<repo-parent>/<repo-dir>-<slug>`.
5. Conflict checks (all together — collect, present, resolve before any mutation):
   - Branch `<type>/<slug>` already exists → ask: check out existing / pick different slug / cancel.
   - `specs/<slug>/` already exists and non-empty → ask: continue editing existing / pick different
     slug / cancel.
   - Worktree path already exists → ask: pick different slug / cancel.
6. Determine branch base: if currently on main/master — branch from there. If on a feature branch
   — ask: branch from current / branch from main / cancel.

**Phase B — side effects (only after Phase A resolves cleanly):**

7. Create branch `<type>/<slug>` from the chosen base.
8. If `--worktree`: `git worktree add <worktree-path> <type>/<slug>`. Print the path. (Otherwise
   switch the current checkout to the new branch.)
9. Ensure `specs/<slug>/` exists (mkdir if missing; leave alone if user chose "continue editing").
10. Invoke skill `task-brainstorming` via the Skill tool, passing `<slug>` and `<type>` as initial
    context.

**Hand-off mechanism:** the slash command body (a markdown file shipped under
`plugins/p-flow/commands/p-flow/task-start.md`) explicitly instructs the assistant to invoke the
named skill via the Skill tool at the end of Phase B. No implicit chaining.

**Windows note:** the worktree path can blow past Windows' 260-char path limit in deep repos.
Recommend `git config --global core.longpaths true` once in the repo's README; the slash command
prints a warning if the resolved path exceeds 200 chars.

### 4.3 Slash command `/p-flow:task-end` — new

Exit point of the task flow.

**Behavior:**

1. Pre-checks:
   - Current branch is not main/master/develop.
   - No uncommitted changes (else: offer to commit the residue with a Conventional Commits message
     drafted from the diff).
   - All checkbox items under `## Steps` and any `## Review follow-ups — *` sections in `plan.md`
     are marked `[x]` (soft warning, not blocking). Items under `## Open questions`, `## Risks`,
     and `## Review decisions (audit)` are *not* checked — they are not steps.
   - Verification marker `.claude/.p-flow-state/<branch>/last-verification` exists and is newer
     than the most recent commit on the branch (soft warning if missing or stale). The marker is
     written by `verification-before-completion` whenever it runs successfully (see §4.6).
2. `git push -u origin <branch>` (skipped if already pushed and up to date).
3. Compose a **recommended MR title and body**:
   - Title — Conventional Commits style from the feature's commits (squash-style summary if
     multiple).
   - Body — distilled from `specification.md` (what/why) plus a checklist drawn from `plan.md`.
4. Output the recommendation as text plus ready-to-copy commands for both GitHub and GitLab CLIs:
   - `gh pr create --title "..." --body "..."`
   - `glab mr create --title "..." --description "..."`
   The command never executes either — the user copies the one matching their host.
5. If `--worktree` was used on `task-start`, remind the user to clean up after merge:
   `git worktree remove ../<repo>-<slug>`. Do not execute.

**What it does not do:** merge, tag, delete branches, run any host-specific CLI.

### 4.4 Skill `task-brainstorming` — new

**Purpose:** through a dialog, elicit task requirements and materialize them as files in
`specs/<slug>/` using p-flow templates. Terminal action is to hand off to `writing-plan`.

**Triggers:**

- `/p-flow:task-start` (always invokes this).
- User says "let's start a feature / bug fix / refactor", "I want to discuss design", etc.
- Any nontrivial change request without an existing spec.

**Input:**

- `<slug>` — required. Skill asks if missing.
- `<type>` (branch type, optional context) — passed by `/p-flow:task-start`. Used only to bias
  initial dialog (e.g. for `bugfix` start with reproduction questions). Does not select a different
  template.
- Short idea description. Optional.

**Flow:**

1. **Precheck on `specs/<slug>/`:**
   - If the dir does not exist — create it; proceed to from-scratch flow.
   - If the dir exists but `specification.md` is missing — proceed to from-scratch flow.
   - If `specification.md` exists *and* contains no `{{PLACEHOLDERS}}` — switch to *refinement*
     mode: read the file, ask the user what to revise, edit in place.
   - If `specification.md` exists *with* `{{PLACEHOLDERS}}` (partially filled) — ask the user:
     resume filling / discard and restart / cancel.
2. **Dialog:** one question at a time. Questions adapt to the implied work:
   - For a feature: problem, user story, actors, acceptance criteria, happy path, errors, edge
     cases, validation.
   - For a bugfix: reproduction, expected vs actual, suspected root cause area, regression
     coverage strategy.
   - For a refactor / tech-task: motivation, scope (in/out, explicit non-goals), approach, NFRs,
     rollback plan.
   - The choice is made **by content of the dialog**, not by a discrete enum.
3. **Decomposition check:** if the request spans multiple independent subsystems, flag it and
   suggest splitting into sub-tasks, each via its own `task-start`.
4. **Materialization:**
   - Read templates from `.claude/templates/p-flow/{specification.md,feature-spec.feature,adr.md}`.
   - If missing — use inline fallbacks shipped with the skill, and recommend `/p-flow:init`.
   - Fill `{{PLACEHOLDERS}}` from the dialog.
   - Always write `specs/<slug>/specification.md`.
   - Write `specs/<slug>/feature.feature` only if behavioral scenarios were captured.
   - Write `specs/<slug>/adr.md` only if an architectural decision needs documentation.
   - Sections that don't apply are **omitted**, not filled with `N/A`. (This relaxes the original
     `rules-p-flow.template.md` rule for non-feature tasks — see migration note in §7.)
5. **Self-review:** scan produced files for placeholders, contradictions, ambiguity, scope. Fix
   inline.
6. **User review gate:** "Spec is in `specs/<slug>/`. Review and tell me what to change before we
   move to the plan."
7. **Hand-off:** on approval, offer to invoke `writing-plan`. On user "yes" — invoke it via the
   Skill tool, passing `<slug>` as initial context. No implicit chaining without confirmation.

**Rigid rules:**

- **Hard gate:** do not invoke `writing-plan` or write any implementation code before the user
  approves the written spec.
- **One question at a time.**
- **No structure invention** — use the p-flow templates as the source of truth for sections.

**Out of scope:**

- Does not write code.
- Does not create `specs/repo.md` (project-wide baseline document referenced by the existing
  `rules-p-flow.template.md` §3 — see that file for context; it is authored once by a human, not
  by skills).
- Does not create `plan.md` (that's `writing-plan`'s job).
- Does not run git commands (those are slash commands' job).

### 4.5 Skill `writing-plan` — new

**Purpose:** turn the brainstorm artifact into a step-by-step plan at `specs/<slug>/plan.md`.

**Input:** a brainstorm artifact at `specs/<slug>/specification.md`. If missing — refuse and tell
user to run `task-brainstorming` first.

**Plan structure:**

```markdown
# Plan — <NAME>

## Steps

1. [ ] <action>
   - **Acceptance**: <how to know this step is done>
   - **Files**: <expected affected files>
2. [ ] ...

## Open questions

- ...

## Risks

- ...
```

**Behavior:**

1. Read the brainstorm artifact in full.
2. Decompose into 5–15 steps. If more — flag and suggest sub-task decomposition.
3. Every step must have a concrete acceptance criterion. Skill refuses to write a step without
   one.
4. Self-review: placeholders, contradictions, steps lacking AC.
5. Show to user → "review and amend, then we move to execution".

**Out of scope:**

- No time estimates.
- No code writing.
- No git operations.

### 4.6 Skill `verification-before-completion` — new

**Purpose:** before any "done / fixed / ready / implemented" claim, run checks and quote the
output. **Evidence before assertions, always.**

**Triggers (MVP):**

- Any assertion of completion.
- Before any commit.

**Triggers (Wave 2, when `executing-plan` ships):**

- At the end of every step in `executing-plan`.

**Rigid rules:**

1. Find and run relevant checks: tests (detected from repo: `npm test`, `pytest`, `cargo test`,
   `go test`, …), linters/formatters if configured, and — if there is a runnable UI/CLI — actually
   run the feature.
2. **Quote** the concrete output (exit codes, key lines). Not paraphrase.
3. On failure — do not claim done. Return to work or to `systematic-debugging` (Wave 2).
4. If there are no tests / verification is not possible — say so explicitly. Never fake success.
5. **On success — write a marker** at `.claude/.p-flow-state/<branch>/last-verification` with
   timestamp and a one-line summary of what ran. `task-end` reads this marker to decide whether
   to warn about missing verification. The marker dir is added to `.gitignore` by the slash
   command on first write.

**Out of scope:**

- Does not write tests (that's part of implementation).
- Does not integrate with CI.

### 4.7 Skill `requesting-code-review` + Agent `code-reviewer` — new

**Skill purpose:** after `verification-before-completion` passes, request an independent code
review of the current diff and triage the findings into plan items.

**Skill behavior:**

1. Verify there is a diff to review (`git status`, `git diff`).
2. Compose a brief for `code-reviewer`: goal of the task (from `specification.md`), what was done
   (from `plan.md` checked steps), focus areas (correctness, security, dead code, style,
   inconsistency).
3. Invoke the `code-reviewer` subagent via the Agent tool.
4. Receive findings grouped by severity (`blocker` / `suggestion` / `nit`).
5. **Triage protocol** (explicit, to avoid AskUserQuestion's 4-option limit becoming a wall):
   - **Blockers**: one at a time. For each — fix / defer (with reason) / reject (with reason).
     No defaults, user must answer.
   - **Suggestions**: presented as a numbered list of up to 10 per batch. User responds with a
     comma-separated list of indices to fix (e.g. "1,3,5"), or "all", or "none". Items not
     selected default to `defer` with reason "not selected". User may add explicit
     reject-reasons inline.
   - **Nits**: presented as a numbered list (no batch limit). Default action — `reject all`. User
     opts in with comma-separated indices to `fix`. No reason required for the default rejection
     ("nit declined").
6. Map triage outcomes to `plan.md`:
   - `fix` → append to "Review follow-ups — <date>" section as a new `[ ]` step with explicit
     acceptance, **continuing the existing step numbering** (never restart).
   - `defer` / `reject` → record in "Review decisions (audit)" with reason.
7. Update `plan.md` accordingly.
8. Tell the user: "Plan updated. When ready to fix, say 'continue' and the new steps will be
   picked up."

**Agent `code-reviewer`:**

- Tools: `Read`, `Glob`, `Grep`, `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git status:*)`. No
  `Edit` / `Write`.
- Input: brief + paths to spec/plan + diff.
- Output: structured findings list with severity, file:line citation, and rationale.
- Behavior: focus on code quality. Do not duplicate `task-reviewer`'s job (spec alignment). If a
  finding is uncertain, mark it as `suggestion` not `blocker`. If nothing is found — say so
  explicitly.

### 4.8 Skill `requesting-task-review` + Agent `task-reviewer` — new

**Skill purpose:** verify that the implementation matches the spec and plan. Orthogonal to
`code-reviewer`.

**Skill behavior:** mirrors `requesting-code-review`, but:

- Brief points the agent at `specification.md`, `feature.feature` (if present), `plan.md`, and the
  diff.
- Agent's deliverable is a structured spec-alignment report, not code-quality findings.
- Same triage flow, same update to `plan.md`.

**Agent `task-reviewer`:**

- Same tools as `code-reviewer`.
- Brief instructs it: "Do not comment on code style or correctness — that is another agent's job.
  Focus only on whether the implementation matches the spec and plan."
- Output sections:
  1. For each acceptance criterion in `specification.md`: implemented / not implemented / partial
     / unclear. Quote file:line for evidence.
  2. For each scenario in `feature.feature` (especially `@error` and `@edge-case`): find
     corresponding code. If not found — flag.
  3. For `plan.md`: which steps are checked, which are not. Unchecked → flag.
  4. **Scope creep:** code present in the diff that was not in the plan. May be justified, but
     must be acknowledged.

### 4.9 Wave 2 skills (sketched, not detailed here)

- `executing-plan` — separate session with review checkpoints after each step. Replaces manual
  "do step → verify → check the box".
- `systematic-debugging` — when `verification` fails or a bug surfaces during `executing-plan`.
  Hypothesis → minimal repro → root cause → fix. No symptom patching.
- `qa-brainstorming` — parallel to `task-brainstorming` with QA-flavored questions (test pyramid,
  coverage, environments, tooling, flakiness). Writes `specs/<slug>/test-plan.md`. Then the
  normal `writing-plan` → `executing-plan` → review pipeline applies.

Wave 2 does not require changes to Wave 1 skills. The hooks are already in place.

---

## 5. Spec directory layout

```
specs/<slug>/
├── specification.md      ← always (written by task-brainstorming)
├── feature.feature       ← optional, only if behavioral scenarios captured
├── adr.md                ← optional, only if an architectural decision needs documenting
├── plan.md               ← written by writing-plan; includes Review follow-ups after review
└── test-plan.md          ← Wave 2, written by qa-brainstorming
```

### `plan.md` structure after a review round

```markdown
# Plan — <NAME>

## Steps

1. [x] Implement handler
   - **Acceptance**: GET /foo returns 200
2. [x] Add tests
   - **Acceptance**: 5 unit tests pass

## Review follow-ups — 2026-05-26

3. [ ] Fix: AC-3 'friendly error' not implemented (task-review, blocker)
   - **Acceptance**: API returns 400 with user-friendly body, not 500 stack trace
4. [ ] Fix: null deref in handler.ts:42 (code-review, blocker)
   - **Acceptance**: handler returns 400 on null input, test added

## Review decisions (audit)

- code-review nit "rename `foo` → `bar`" — **rejected**: name is correct in domain
- task-review suggestion "add latency metric" — **deferred**: out of scope, follow-up TBD
```

**Numbering:** step numbers are **continuous across the file** and **never restart between review
rounds**. A second review round on 2026-05-27 appends a new `## Review follow-ups — 2026-05-27`
section with steps `5, 6, ...`, decisions accumulate in the same `## Review decisions (audit)`
section.

---

## 6. End-to-end walkthrough

A developer wants to add a new endpoint `GET /users/:id/avatar`.

1. `/p-flow:task-start avatar-endpoint`
   - Asks branch type → "feature".
   - Creates `feature/avatar-endpoint`, checks out.
   - Creates empty `specs/avatar-endpoint/`.
   - Hands off to `task-brainstorming`.
2. `task-brainstorming` runs a Q&A dialog. Produces:
   - `specs/avatar-endpoint/specification.md` — full feature spec.
   - `specs/avatar-endpoint/feature.feature` — three scenarios (happy, 404, malformed id).
   - No `adr.md` (no architectural decision needed).
3. User approves spec. Skill hands off to `writing-plan`.
4. `writing-plan` produces `specs/avatar-endpoint/plan.md` with 7 steps. User approves.
5. User implements step 1 manually (or via Wave 2 `executing-plan`).
6. User says "I'm done with step 1". `verification-before-completion` triggers:
   - Runs `npm test`. Quotes "47 tests pass".
   - User checks box on step 1 in `plan.md`.
7. Repeat for remaining steps.
8. After step 7, user says "ready for review". `requesting-code-review` runs:
   - `code-reviewer` agent returns 1 blocker (null deref) and 2 nits.
   - Triage: blocker → plan step 8, nits → rejected with reasons.
   - `plan.md` updated.
9. `requesting-task-review` runs:
   - `task-reviewer` agent returns 1 blocker (AC-3 not implemented).
   - Triage: blocker → plan step 9.
   - `plan.md` updated.
10. User says "continue". Implements steps 8 and 9. Each step gets `verification`.
11. (Optional) re-run reviews on fresh diff.
12. `/p-flow:task-end`:
    - Pre-checks pass.
    - `git push -u origin feature/avatar-endpoint`.
    - Prints MR title and body, plus `gh` and `glab` commands.
13. User copies the relevant command, opens MR in their host.

---

## 7. Versioning and migration

### What `/p-flow:init` ships changes

**Template composition: unchanged.** `init` still ships the same five source files under
`skills/_shared/templates/` (`rules-p-flow.template.md`, `adr.template.md`,
`feature-spec.template.feature`, `specification.template.md`, `settings.template.json`) and still
materializes the same artifacts in the target repo (three spec templates under
`.claude/templates/p-flow/`, `.claude/rules/p-flow.md`, merged `.claude/settings.json`).

**Rules content update:** `rules-p-flow.template.md` gets a new section `## 4. Skills and flow`
that documents the new skills, slash commands, and the spec directory layout. It also relaxes the
old rule "if a section doesn't apply, write `N/A` and a one-line reason — do not delete the
heading" for non-feature tasks (refactor / bugfix specs may omit irrelevant sections entirely).

### Migration for repos initialized before this update

- The skills do not depend on the new rules section being present. They work in any repo.
- Repos that want the updated rules should delete `.claude/rules/p-flow.md` and re-run
  `/p-flow:init`.

### Plugin version bump

- Adding skills, agents, and slash commands → **minor bump** (additive, backwards-compatible).
- Updating `rules-p-flow.template.md` content → **minor bump** (additive section).
- Combined: single **minor bump** when Wave 1 ships (e.g. `0.1.0` → `0.2.0`).

Release is not done automatically. The user controls release cadence (per memory:
`no-proactive-releases`).

---

## 8. Open decisions resolved during brainstorming

| Decision | Resolution |
|---|---|
| Process discipline vs artifact-only | Process discipline (skills + agents). |
| Relationship with `superpowers` | Replace. p-flow becomes the user's primary plugin. |
| Fate of existing `/p-flow:init` content | Keep as is. Skills reference it but do not require it. |
| Worktree | Optional flag on `task-start`. Default off. |
| MR creation | Recommend only. Print `gh` and `glab` commands; user picks. |
| MVP scope | 5 skills: `task-brainstorming`, `writing-plan`, `verification-before-completion`, `requesting-code-review`, `requesting-task-review`. Wave 2: `executing-plan`, `systematic-debugging`, `qa-brainstorming`. |
| Skill language | English. |
| Type-of-work as first-class enum | No (Variant B). One brainstorming skill, one flexible template, type only affects branch prefix. |
| Per-domain brainstorming | Yes. `task-brainstorming` (dev) in MVP; `qa-brainstorming` in Wave 2; DevOps documented as extension point only. |
| Code review vs task review | Two separate skills + two separate agents. Orthogonal lenses. |
| Reviewers fix vs report | Report only. Read-only agents. Findings become plan items after user triage. |
| Triage location | Inside review skills (MVP). Promote to dedicated `processing-review-findings` skill in Wave 2 only if needed. |

---

## 9. Future considerations

- **`ci-mr-review` skill (Wave 3)** — non-interactive wrapper around the existing
  `code-reviewer` and `task-reviewer` agents, designed for CI/CD pipelines reviewing merge /
  pull requests.

  **Contract:**
  - **Inputs (env or CLI args):** `CI_BASE_SHA`, `CI_HEAD_SHA` (diff range, required);
    `CI_SPEC_PATH` (optional, default tried: `specs/<branch-slug>/`); `CI_POST_COMMENTS`
    (boolean, default false); `CI_PROVIDER` (auto-detected from `GITHUB_ACTIONS` /
    `GITLAB_CI` env if missing).
  - **Behavior:**
    1. Probe for `specification.md` under `CI_SPEC_PATH`. If present — dispatch both
       `code-reviewer` and `task-reviewer` in parallel (`dispatching-parallel-agents` pattern).
       If absent — dispatch only `code-reviewer`, and prepend a note to output:
       *"No spec found at `<path>` — task-review skipped."*
    2. Aggregate findings. **No triage** — CI has no user.
    3. Output: if `CI_POST_COMMENTS=true` — post via `gh pr review --comment` or
       `glab mr note`. Otherwise — print Markdown to stdout.
  - **Exit codes:** `0` — no blockers; `1` — at least one blocker (CI gate fails); `2` —
    internal error (agent failure, git unavailable, etc.).
  - **Why it works:** reuses the MVP agents as-is (no duplication), graceful spec-degrade is
    first-class (matches the reality that most repos have no p-flow specs), and exit codes make
    it a real CI gate rather than informational noise.
  - **Placement:** same plugin (`p-flow`), not a separate `p-ci`. Co-located with the agents
    it depends on. Spin-off only if CI surface grows significantly (deploy-checks,
    spec-linters, etc.).

- **DevOps domain (`runbook-brainstorming` + `executing-runbook`)** — runbook artifact, per-step
  confirmation gates, observability-based verification, oncall sign-off as a review variant.
  Designed as a future extension; no MVP work.
- **`processing-review-findings` as a dedicated skill** — pull triage out of review skills when
  policies grow (e.g. "auto-add all blockers", "batch nits without asking").
- **`security-review` skill + `security-reviewer` agent** — a third review lens for
  security-specific concerns.
- **Parallel reviewers** — run `code-reviewer` and `task-reviewer` simultaneously via
  `dispatching-parallel-agents`-style orchestration. Optimization, not a correctness change.
- **Strict TDD skill** — optional `test-driven-development` skill for teams that want a hard
  red-green-refactor cycle.
- **Wave 2 `executing-plan` with checkpoint-per-step** — automates the manual
  "do step → verify → check box" loop and integrates `systematic-debugging` automatically on
  verification failure.

---

## 10. Related work

- `superpowers` (public plugin) — design inspiration; specifically `brainstorming`,
  `writing-plans`, `executing-plans`, `verification-before-completion`, `requesting-code-review`,
  `systematic-debugging`. p-flow replaces these in the user's setup with a leaner, multi-file,
  template-driven equivalent.
- Existing `p-flow` (this repo) — `/p-flow:init`, three templates, deny-list. Untouched in
  composition; only `rules-p-flow.template.md` content is updated.
