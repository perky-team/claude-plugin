# Spec Audit Subagent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `task-brainstorming`'s shallow inline §5 self-review with a fresh-context auditor subagent that finds logical errors and inconsistencies in the spec, fixes them itself, and loops (max 3 passes, Blockers-driven) until the spec is clean — asking the user when a fix needs a decision.

**Architecture:** A colocated read-write reviewer template (`spec-auditor.md`) dispatched by `task-brainstorming` via the `Task` tool with `subagent_type: general-purpose` — the same Wave A pattern used by `code-reviewer.md` / `task-reviewer.md`, except this one edits the spec files (specs only; code/plan reviewers stay read-only). `task-brainstorming` drives a 3-pass loop and relays the subagent's user-questions.

**Tech Stack:** Markdown skill artifacts (SKILL.md + colocated `.md` template), Vitest for the invariant tests, `plugin.json` / `README.md` / `CLAUDE.md` / `RELEASE-NOTES.md` for docs + manifest.

## Global Constraints

- All Claude Code artifacts (SKILL.md, templates, README, CLAUDE.md) are written in **English** — per global CLAUDE.md.
- Reviewer templates MUST contain a `## What is NOT your scope` section — enforced by `tests/review-template-refs.test.ts`.
- The audit runs **only** on full `task-brainstorming` specs — never on `/p-flow:init` Phase 2 stub specs.
- Loop cap is **3 passes**; only **Blockers** keep the loop running. After pass 3, remaining Blockers are handed to the user at §6.
- The subagent **fixes directly** when the resolution is unambiguous, and **asks the user** (never guesses) when a fix needs a decision.
- Design doc: `plugins/p-flow/docs/specs/2026-07-02-spec-audit-subagent.md`.
- Tests live at repo-root `tests/`, run with `npx vitest run`.

---

### Task 1: Invariant test for the spec-audit wiring (RED first)

**Files:**
- Test: `tests/p-flow-spec-audit.test.ts` (create)

**Interfaces:**
- Consumes: `repoRoot()` from `tests/helpers.ts`.
- Produces: nothing consumed by later tasks — this is the guard that Tasks 2–3 satisfy.

- [ ] **Step 1: Write the failing test**

Create `tests/p-flow-spec-audit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

// Defends the spec-audit subagent wiring in task-brainstorming:
// - the colocated read-write auditor template ships and declares its non-scope
// - task-brainstorming dispatches it via the colocated-template convention
// - the 3-pass cap and Blockers-drive-the-loop rule are documented (not silently
//   droppable), and `Task` is declared in allowed-tools.
const skillDir = join(repoRoot(), 'plugins/p-flow/skills/task-brainstorming');
const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');

describe('p-flow spec audit subagent', () => {
  it('ships the spec-auditor template alongside task-brainstorming', () => {
    expect(existsSync(join(skillDir, 'spec-auditor.md'))).toBe(true);
  });

  it('spec-auditor declares its non-scope (code/plans out)', () => {
    const t = readFileSync(join(skillDir, 'spec-auditor.md'), 'utf-8');
    expect(t).toContain('## What is NOT your scope');
  });

  it('task-brainstorming dispatches the auditor via the colocated template', () => {
    expect(skill).toContain('${CLAUDE_SKILL_DIR}/spec-auditor.md');
  });

  it('task-brainstorming declares Task in allowed-tools', () => {
    const fm = skill.split('---')[1] ?? '';
    expect(fm).toMatch(/allowed-tools:.*\bTask\b/);
  });

  it('§5 documents the 3-pass cap and the Blockers-drive-the-loop rule', () => {
    expect(skill).toMatch(/3 passes/);
    expect(skill).toMatch(/Only Blockers drive the loop/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/p-flow-spec-audit.test.ts`
Expected: FAIL — `spec-auditor.md` does not exist yet; SKILL.md has no template reference, no `Task` in allowed-tools, no cap wording.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/p-flow-spec-audit.test.ts
git commit -m "test(p-flow): guard spec-audit subagent wiring in task-brainstorming"
```

---

### Task 2: Create the `spec-auditor.md` template

**Files:**
- Create: `plugins/p-flow/skills/task-brainstorming/spec-auditor.md`
- Test: `tests/p-flow-spec-audit.test.ts` (from Task 1) + `tests/review-template-refs.test.ts` (auto-covers once Task 3 references it)

**Interfaces:**
- Consumes: nothing.
- Produces: a template whose inlined content is the auditor subagent's full prompt. Its return contract — three sections `### Fixed` / `### Blockers remaining` / `### Questions for the user` — is what `task-brainstorming` §5 (Task 3) parses.

- [ ] **Step 1: Write the template file**

Create `plugins/p-flow/skills/task-brainstorming/spec-auditor.md` with exactly this content:

````markdown
You are a senior engineer auditing a freshly written feature specification for **logical errors and inconsistencies** — and, unlike p-flow's code/plan reviewers, you **FIX** what you find. You have read-write access to the spec files. Specs are prose and always pass a human review gate after you, so direct edits are safe here; code and plans are never in your scope.

## Your scope (and only this)

Audit every file in `specs/<slug>/` named in the brief — `specification.md` (always), and `feature.feature` / `adr.md` when present — for:

- **Logical errors** — requirements that cannot all hold at once; acceptance criteria that contradict the happy path or each other.
- **Internal contradictions** — a statement in one section negated by another.
- **Cross-file inconsistencies** — `specification.md` ↔ `feature.feature` ↔ `adr.md` disagree (a scenario with no matching requirement; an ADR decision the spec contradicts).
- **Ambiguous requirements** — a requirement readable two different ways.
- **Coverage gaps** — a stated behavior with no acceptance criterion; an error/edge case named in prose but absent from the scenarios.
- **Scope creep** — requirements drifting into work outside this task's problem statement.

## What is NOT your scope

- **Code, tests, plans.** You never read or edit code, `plan.md`, or p-tasks. You audit spec prose only.
- **Designing new behavior.** You do not invent features, choose products/libraries, or make requirements decisions. When resolving an issue needs such a decision, it becomes a QUESTION, not an edit.
- **Wording taste.** Cosmetic rewording that removes no real ambiguity is a Nit at most — do not churn the prose.

## Fix vs. ask — the rule

- **Fix directly** when the correct resolution is unambiguous from the spec's own context: a contradiction where one side is clearly the stale one; a missing acceptance criterion the happy path already implies; a cross-file drift with one obviously-correct side.
- **Ask the user** — do NOT guess — when resolving the issue needs information or a decision not present in the spec. Return it as a question tied to the Blocker. Guessing on genuine ambiguity is a failure.

## Severity

- **Blocker** — a logical error, internal contradiction, cross-file inconsistency, unreachable/contradictory scenario, or a missing / self-contradictory acceptance criterion. Fix it, or (if it needs a decision) raise a question.
- **Suggestion** — a clarity / completeness improvement. Fix in-pass when unambiguous.
- **Nit** — cosmetic. Fix in-pass.

## Inputs you receive from the brief

- Paths to the files in `specs/<slug>/` to audit (`specification.md` always; `feature.feature` / `adr.md` when they exist).
- On passes after the first: the user's answers to questions you raised on an earlier pass — apply them.

## Procedure

1. Read every provided spec file in full.
2. Build the issue list across all six checks above, each tagged by severity.
3. For each issue: if unambiguously fixable, edit the file; otherwise record a question tied to its Blocker.
4. Re-read your own edits — confirm a fix did not introduce a new contradiction.
5. Return the structured result below.

## Output format

Return exactly this structure. This IS your return value — not a message to a human.

```
## Spec audit — pass result

### Fixed
- `<file>` — <what changed> (<why>)
(empty → "None.")

### Blockers remaining
(Blockers you could NOT fix because they need a user decision. Empty → "None.")
- <blocker> — needs answer to Q<n>

### Questions for the user
(Each tied to a remaining Blocker. Empty → "None.")
- Q1: <question>
```

If the spec is clean and you changed nothing: all three sections are "None."

## Tone

Direct, evidence-based. Quote the exact spec line you changed or question. Do not editorialize on whether a requirement *should* exist — only on whether the spec is internally sound and self-consistent.
````

- [ ] **Step 2: Run the auditor-specific assertions**

Run: `npx vitest run tests/p-flow-spec-audit.test.ts -t "spec-auditor"`
Expected: the two `spec-auditor` assertions (`ships the ... template`, `declares its non-scope`) now PASS. The three SKILL.md assertions still FAIL (Task 3 not done).

- [ ] **Step 3: Commit**

```bash
git add plugins/p-flow/skills/task-brainstorming/spec-auditor.md
git commit -m "feat(p-flow): add read-write spec-auditor template for task-brainstorming"
```

---

### Task 3: Rewrite `task-brainstorming` §5 and §6, add `Task` to allowed-tools

**Files:**
- Modify: `plugins/p-flow/skills/task-brainstorming/SKILL.md` (frontmatter `allowed-tools`; §5 body; §6 body)
- Test: `tests/p-flow-spec-audit.test.ts`, `tests/review-template-refs.test.ts`, `tests/skills.test.ts`

**Interfaces:**
- Consumes: `${CLAUDE_SKILL_DIR}/spec-auditor.md` (Task 2) and its 3-section return contract.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add `Task` to allowed-tools**

In `plugins/p-flow/skills/task-brainstorming/SKILL.md`, change the frontmatter line:

```
allowed-tools: Read Write Edit Bash(git rev-parse:*) Bash(test:*) WebSearch WebFetch
```

to:

```
allowed-tools: Read Write Edit Bash(git rev-parse:*) Bash(test:*) WebSearch WebFetch Task
```

- [ ] **Step 2: Replace §5 (Self-review) with the audit loop**

Replace this block:

```markdown
### 5. Self-review

Scan produced files for:

- Placeholders still present (`{{`, `TBD`, `TODO`).
- Internal contradictions.
- Ambiguous requirements (could be interpreted two ways).
- Scope creep into adjacent work.

Fix inline.
```

with:

```markdown
### 5. Spec audit (subagent loop)

Before showing the spec to the user, dispatch a **fresh-context auditor subagent** to hunt logical errors and inconsistencies and fix them. This replaces a shallow inline self-review — the auditor reads the spec with no authoring bias. (Runs only on this full spec — never on `/p-flow:init` Phase 2 stubs.)

First, a one-line inline guard: if any `{{PLACEHOLDER}}`, `TBD`, or `TODO` is still present, fill it from the dialog before dispatching — the auditor audits meaning, not leftover template holes.

Then loop, `pass = 1..3`:

1. Dispatch via the `Task` tool with `subagent_type: general-purpose`. The prompt is the content of `${CLAUDE_SKILL_DIR}/spec-auditor.md`, followed by: the paths of every file in `specs/<slug>/`, and — on passes after the first — the user's answers to any questions raised so far.
2. The subagent fixes what it can unambiguously fix (all severities) and returns `### Fixed` / `### Blockers remaining` / `### Questions for the user`.
3. Act on the result:
   - **Questions present** → ask the user **one at a time**, collect answers, and re-dispatch with them **without advancing `pass`** (a question round is not a wasted pass — the subagent still has to apply the resolution).
   - **No questions and no Blockers remaining** → the spec is clean. Exit the loop.
   - **No questions but Blockers remain** → advance `pass` and re-dispatch (a fresh pass catches regressions the fixes introduced).
4. **Cap: 3 passes.** If Blockers still remain after pass 3, stop looping and carry the remaining list into §6 — never loop indefinitely.

**Only Blockers drive the loop.** Suggestions and Nits are fixed in-pass but never keep the loop running.
```

- [ ] **Step 3: Update §6 to summarize audit changes**

Replace this block:

```markdown
### 6. User review gate

Say: *"Spec written in `specs/<slug>/`. Review and tell me what to change before we move to the plan."*

Wait for response. If user requests changes — apply, re-run §5.
```

with:

```markdown
### 6. User review gate

Summarize what the auditor changed across all passes (one line per file). If any Blockers remained after the 3-pass cap, list them explicitly so the user decides.

Say: *"Spec written in `specs/<slug>/` and audited. What the audit changed: <summary>. Review and tell me what to change before we move to the plan."*

Wait for response. If user requests changes — apply, and re-run §5 when the change is substantive.
```

- [ ] **Step 4: Run the targeted tests**

Run: `npx vitest run tests/p-flow-spec-audit.test.ts tests/review-template-refs.test.ts`
Expected: PASS — all five spec-audit assertions green; `review-template-refs` now also covers `spec-auditor.md` (exists + `## What is NOT your scope`) via `task-brainstorming`'s new reference.

- [ ] **Step 5: Run the skills-frontmatter test**

Run: `npx vitest run tests/skills.test.ts`
Expected: PASS — `allowed-tools` still parses with `Task` appended; description/body unchanged.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-flow/skills/task-brainstorming/SKILL.md
git commit -m "feat(p-flow): drive spec audit via subagent loop in task-brainstorming"
```

---

### Task 4: Docs + manifest — README, CLAUDE.md, RELEASE-NOTES, version bump

**Files:**
- Modify: `plugins/p-flow/README.md` (Reviewer templates section + intro sentence)
- Modify: `plugins/p-flow/CLAUDE.md` (architecture-decision row + Reviewer-templates note)
- Modify: `plugins/p-flow/RELEASE-NOTES.md` (new version section)
- Modify: `plugins/p-flow/.claude-plugin/plugin.json` (`version`)
- Test: full suite

**Interfaces:**
- Consumes: the behavior finalized in Tasks 2–3.
- Produces: nothing.

- [ ] **Step 1: Update the README Reviewer-templates section**

In `plugins/p-flow/README.md`, replace the intro sentence of `## Reviewer templates`:

```markdown
The `requesting-code-review` and `requesting-task-review` skills dispatch the **`general-purpose`** subagent via the `Task` tool, inlining a reviewer prompt template from the skill's own directory:
```

with:

```markdown
The `requesting-code-review`, `requesting-task-review`, and `task-brainstorming` skills dispatch the **`general-purpose`** subagent via the `Task` tool, inlining a reviewer prompt template from the skill's own directory:
```

Then add this row to the template table (after the `task-reviewer.md` row):

```markdown
| [`skills/task-brainstorming/spec-auditor.md`](./skills/task-brainstorming/spec-auditor.md) | `task-brainstorming` | Spec audit: logical errors, internal contradictions, cross-file inconsistencies, coverage gaps, scope creep. **Read-write** — fixes the spec directly (specs only), loops max 3 passes on Blockers. |
```

- [ ] **Step 2: Add the CLAUDE.md architecture-decision row**

In `plugins/p-flow/CLAUDE.md`, in the `## Architecture decisions` table, add a row:

```markdown
| Spec audit as a **read-write** subagent in `task-brainstorming` §5 (replacing the inline self-review): the one sanctioned exception to "reviews are read-only", and only for specs — prose, cheap, and always gated by the §6 human review. Dispatched via `Task` + `general-purpose` + colocated `spec-auditor.md` (Wave A pattern). Loop capped at 3 passes, Blockers-driven; genuine ambiguity is escalated to the user, never guessed. Code/plan reviewers stay read-only. | J | `docs/specs/2026-07-02-spec-audit-subagent.md`, `docs/plans/2026-07-02-spec-audit-subagent.md` |
```

Then in the `## Reviewer templates (Wave A pattern)` section, append a note after the bullet list:

```markdown
- `skills/task-brainstorming/spec-auditor.md` follows the same colocated-template + `Task`/`general-purpose` dispatch pattern, but is **read-write** (it fixes the spec) — unlike `code-reviewer.md` / `task-reviewer.md`, which are read-only. All three must keep a `## What is NOT your scope` section (`tests/review-template-refs.test.ts`).
```

- [ ] **Step 3: Add a RELEASE-NOTES section**

In `plugins/p-flow/RELEASE-NOTES.md`, add a new section directly under the `# p-flow Release Notes` header block (above the current `## Unreleased — ... 1.6.0` entry, keeping that entry intact):

```markdown
## Unreleased — `plugins/p-flow 1.7.0` — spec audit subagent in task-brainstorming

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
```

- [ ] **Step 4: Bump the plugin version**

In `plugins/p-flow/.claude-plugin/plugin.json`, change:

```json
  "version": "1.6.0",
```

to:

```json
  "version": "1.7.0",
```

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS — including `tests/plugin-readme-coverage.test.ts` (task-brainstorming already listed), `tests/plugin-manifests.test.ts` (valid `plugin.json`), `tests/review-template-refs.test.ts`, and `tests/p-flow-spec-audit.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-flow/README.md plugins/p-flow/CLAUDE.md plugins/p-flow/RELEASE-NOTES.md plugins/p-flow/.claude-plugin/plugin.json
git commit -m "docs(p-flow): document spec-auditor template and bump to 1.7.0"
```

---

## Self-Review

**Spec coverage:**
- Where it lives (replace §5) → Task 3. ✔
- Read-write fix model → `spec-auditor.md` (Task 2) + §5 rewrite (Task 3). ✔
- Loop-until-clean, Blockers-driven, 3-pass cap → §5 rewrite (Task 3) + test (Task 1). ✔
- User-question escape hatch → `spec-auditor.md` return contract (Task 2) + §5 step 3 (Task 3). ✔
- Checks list (logical/contradiction/cross-file/ambiguity/coverage/scope) → `spec-auditor.md` (Task 2). ✔
- Severity model reuse → `spec-auditor.md` (Task 2). ✔
- Scope: task-brainstorming only, not init Phase 2 → §5 parenthetical (Task 3). ✔
- Automatic, not gated → §5 runs unconditionally after §4 (Task 3). ✔
- Dispatch via Task + general-purpose + colocated template → Task 2/3. ✔
- Tests → Task 1 (new guard) + Task 3 relies on auto-coverage by `review-template-refs`. ✔
- Docs/manifest → Task 4. ✔
- Rationale for overriding read-only → CLAUDE.md row (Task 4). ✔

No gaps.

**Placeholder scan:** No TBD/TODO/"handle appropriately" in steps — every step shows exact file content, exact commands, exact expected output. The `<summary>`, `<file>`, `<what changed>`, `Q<n>` tokens are literal parts of the template/skill prose (intended output shape), not plan placeholders.

**Type consistency:** The three return-section headings (`### Fixed` / `### Blockers remaining` / `### Questions for the user`) are identical in `spec-auditor.md` (Task 2) and in the §5 rewrite (Task 3). `${CLAUDE_SKILL_DIR}/spec-auditor.md` reference string matches the test regex in Task 1. `allowed-tools` string in Task 3 matches the `\bTask\b` assertion in Task 1. Version `1.7.0` consistent across plugin.json (Task 4) and RELEASE-NOTES (Task 4).
