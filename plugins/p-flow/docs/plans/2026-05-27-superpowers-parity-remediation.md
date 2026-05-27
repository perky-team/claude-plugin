# p-flow — superpowers parity remediation (master plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the 4 remediation waves identified in `plugins/p-flow/docs/specs/2026-05-27-superpowers-parity.md`, per the user decisions recorded there (Q1 migrate inline, Q2 partial TDD adopt, Q3 task-end stay narrow, Q4 no verification fix needed).

**Spec reference:** `plugins/p-flow/docs/specs/2026-05-27-superpowers-parity.md` — the parity gap report.
**Audit plan reference:** `plugins/p-flow/docs/plans/2026-05-27-superpowers-parity-audit.md`.

**Structure:** Four sequential waves, each shipped as its own release. Wave A is fully detailed (immediately actionable); Waves B–D are outlined here and expanded into their own detailed plans when Wave A ships.

---

## Wave map

| Wave | Goal | Releases | Depends on |
|---|---|---|---|
| **A** | Migrate `code-reviewer` + `task-reviewer` from registered agents to inline templates colocated with their requesting skills | `v4.7.0` (minor — breaking pattern change for downstream) | nothing — first to land |
| **B** | Add `using-p-flow` discovery skill + session-start hook | `v4.8.0` (minor — new skill + new hook) | independent of A; can run in parallel |
| **C** | Add `test-driven-development` + `receiving-code-review` skills + revise `writing-plan` template to offer TDD shape | `v4.9.0` (minor — 2 new skills + breaking change to plan template default) | independent |
| **D** | Cleanup batch: 9 medium/low-priority items (extract using-git-worktrees, add writing-skills, allowed-tools cleanup, Graphviz adoption, Announce convention, RELEASE-NOTES, plugin CLAUDE.md, task-end design note for Q3, dispatching-parallel-agents) | `v4.10.0` (minor) | depends on B for one item (`<EXTREMELY-IMPORTANT>` on discovery skill); rest independent |

Total estimated work: **~11 hours across 4 releases.**

---

# Wave A — Migrate agents to inline templates

**Files:**
- Modify: `plugins/p-flow/skills/requesting-code-review/SKILL.md` (dispatch via `Task tool` with template path)
- Create: `plugins/p-flow/skills/requesting-code-review/code-reviewer.md` (template — body of current `agents/code-reviewer.md`)
- Modify: `plugins/p-flow/skills/requesting-task-review/SKILL.md` (same shape)
- Create: `plugins/p-flow/skills/requesting-task-review/task-reviewer.md` (template — body of current `agents/task-reviewer.md`)
- Delete: `plugins/p-flow/agents/code-reviewer.md`
- Delete: `plugins/p-flow/agents/task-reviewer.md`
- Delete: `plugins/p-flow/agents/` (empty after the two deletes)
- Modify: `tests/agents.test.ts` (no longer applicable — agents/ dir gone)
- Modify: `tests/subagent-refs.test.ts` (semantic shift — instead of asserting `subagent_type:` resolves to a registered agent name, assert the colocated template file exists)
- Modify: `plugins/p-flow/README.md` (Subagents section → Templates section)
- Modify: `plugins/p-flow/.claude-plugin/plugin.json` (description: remove "Subagents: code-reviewer, task-reviewer")
- Modify: `.claude-plugin/marketplace.json` (same description update)
- Modify: `plugins/p-flow/docs/specs/2026-05-26-task-flow-design.md` (Architecture section — update agents section to describe template pattern)

## Tasks

### A-1: Extract `code-reviewer.md` template

- [ ] **Step 1: Copy current agent body to new location**

```bash
mkdir -p plugins/p-flow/skills/requesting-code-review
# Copy body (without YAML frontmatter — templates have no frontmatter):
# read agents/code-reviewer.md → strip first --- to --- block → write to skills/requesting-code-review/code-reviewer.md
```

The new file at `plugins/p-flow/skills/requesting-code-review/code-reviewer.md`:
- starts with `You are a senior engineer doing a focused code review...` (no frontmatter)
- ends with the existing Tone section
- NOTE: keep the in-body scope-discipline edits from `ad2b097` ("MUST omit" wording + self-check step 4)

- [ ] **Step 2: Validate**

```bash
diff <(sed -n '/^---$/,/^---$/!p' plugins/p-flow/agents/code-reviewer.md) plugins/p-flow/skills/requesting-code-review/code-reviewer.md
```
Expected: identical content (modulo first/last blank lines).

- [ ] **Step 3: Commit**

```bash
git add plugins/p-flow/skills/requesting-code-review/code-reviewer.md
git commit -m "feat(p-flow): extract code-reviewer template into requesting-code-review skill dir"
```

### A-2: Update `requesting-code-review/SKILL.md` to dispatch via Task tool

- [ ] **Step 1: Replace dispatch instruction**

In `plugins/p-flow/skills/requesting-code-review/SKILL.md` §"2. Dispatch the agent", replace:

```
Use the Agent tool with `subagent_type: code-reviewer`. Pass the brief composed above plus the literal paths to `specification.md` and `plan.md` so the agent can read them for context.
```

with:

```
Use the Task tool with `subagent_type: general-purpose`. The prompt MUST start with the full content of `${CLAUDE_SKILL_DIR}/code-reviewer.md` (read it via the Read tool, then inline), followed by a `## Brief` section containing the goal / what-was-done / focus areas / diff command / spec & plan paths composed above.
```

- [ ] **Step 2: Update `allowed-tools` frontmatter**

Replace `Agent` with `Task` in the `allowed-tools:` line.

- [ ] **Step 3: Verify all body references to "Agent tool" are updated**

```bash
grep -n "Agent tool\|subagent_type: code-reviewer" plugins/p-flow/skills/requesting-code-review/SKILL.md
```
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add plugins/p-flow/skills/requesting-code-review/SKILL.md
git commit -m "refactor(p-flow): dispatch code-reviewer as Task tool template, not registered agent"
```

### A-3 + A-4: Symmetric for task-reviewer

- [ ] Repeat A-1 and A-2 for `task-reviewer` (extract template + update `requesting-task-review/SKILL.md`).

### A-5: Delete `agents/` directory

- [ ] **Step 1: Confirm no other skills reference `subagent_type: <p-flow-agent>`**

```bash
grep -rn "subagent_type: code-reviewer\|subagent_type: task-reviewer" plugins/p-flow/
```
Expected: no matches outside the (now-replaced) review skills.

- [ ] **Step 2: Delete**

```bash
git rm plugins/p-flow/agents/code-reviewer.md plugins/p-flow/agents/task-reviewer.md
rmdir plugins/p-flow/agents
```

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(p-flow): remove registered agents/ (migrated to inline templates per Wave A)"
```

### A-6: Update tests

- [ ] **Step 1: Drop `tests/agents.test.ts`**

```bash
git rm tests/agents.test.ts
```

Rationale: there are no more `agents/*.md` files. The structural assertions (read-only tools, NOT-your-scope section, frontmatter) need to move to templates — but templates are markdown without frontmatter. New assertion shape needed.

- [ ] **Step 2: Refactor `tests/subagent-refs.test.ts` → `tests/review-template-refs.test.ts`**

New invariant: each `requesting-*-review` SKILL.md must reference a template file at `${CLAUDE_SKILL_DIR}/<reviewer>.md`, AND that file must exist AND must contain a `## What is NOT your scope` section (the discipline structure survives the migration).

- [ ] **Step 3: Run + commit**

```bash
npm test 2>&1 | tail -5
```
Expected: green; test count drops by ~16 (agents.test.ts gone) and gains ~4 (new review-template-refs.test.ts).

```bash
git add tests/
git commit -m "test(p-flow): replace agents.test.ts with review-template structural test"
```

### A-7: Update plugin metadata

- [ ] **Step 1: Update p-flow plugin.json description**

Remove `"Subagents: code-reviewer, task-reviewer."` suffix from the long description in `plugins/p-flow/.claude-plugin/plugin.json`. Same edit in `.claude-plugin/marketplace.json` p-flow entry.

- [ ] **Step 2: Update p-flow README**

Replace `## Subagents` table with `## Reviewer templates` table pointing at the new locations.

- [ ] **Step 3: Update design spec**

In `plugins/p-flow/docs/specs/2026-05-26-task-flow-design.md` Architecture section, add a note explaining the post-Wave-A pattern (inline templates aligned with superpowers v5.1.0).

- [ ] **Step 4: Commit**

```bash
git add plugins/p-flow/.claude-plugin/plugin.json .claude-plugin/marketplace.json plugins/p-flow/README.md plugins/p-flow/docs/specs/2026-05-26-task-flow-design.md
git commit -m "docs(p-flow): update metadata + design spec for inline reviewer templates"
```

### A-8: Smoke-test the migration

- [ ] **Step 1: Repeat the smoke-test from earlier (sandbox repo + dispatch)**

In a scratch sandbox repo, dispatch the new pattern: `Task` tool with `general-purpose` + inline-read `code-reviewer.md` template content. Verify the agent produces a structured review.

- [ ] **Step 2: If structural test passes — proceed to release**

Critical: the smoke-test now should work WITHOUT requiring `p-flow` to be installed (because there's no registered agent to look up — we use `general-purpose`). This is the portability fix.

### A-9: Release

- [ ] **Step 1: Run full validator + tests**

`npm run validate && npm test`

- [ ] **Step 2: Bump versions**

- `plugins/p-flow/.claude-plugin/plugin.json` `version`: `0.2.0` → `0.3.0` (minor — agent dispatch pattern changed; breaking for any external caller of `Task (p-flow:code-reviewer)`)
- Marketplace tag: next minor — `v4.7.0`

- [ ] **Step 3: Propose to user + confirm + tag**

Per `wiki/.claude/CLAUDE.md`: state the version + reasoning, wait for confirmation, then push + tag.

---

# Wave B — Discovery skill + session-start hook

**Outline only.** Full plan to be authored when Wave A ships.

**Files to create:**
- `plugins/p-flow/skills/using-p-flow/SKILL.md` — mirror of `superpowers:using-superpowers` but scoped to p-flow's surface. Use `<EXTREMELY-IMPORTANT>` and `<SUBAGENT-STOP>` XML tags.
- `plugins/p-flow/hooks/hooks.json` — `SessionStart` hook wiring.
- `plugins/p-flow/hooks/session-start` — bash script that emits the using-p-flow skill body as a `<system-reminder>`.
- `plugins/p-flow/hooks/run-hook.cmd` — Windows entry point (mirror superpowers').

**Files to modify:**
- `plugins/p-flow/.claude-plugin/plugin.json` — add `hooks/` reference if required by manifest spec.
- `plugins/p-flow/README.md` — document the discovery skill + hook.
- `tests/skills.test.ts` — already covers SKILL.md structure; new skill auto-picked up.

**Release:** `v4.8.0`, `plugins/p-flow` `0.3.0` → `0.4.0` (minor — new skill + new hook).

**Open question for Wave B planning:** does Claude Code's plugin manifest format have a standard place to declare hooks (vs. just having `hooks/` dir present)? Check `superpowers .claude-plugin/plugin.json` — it doesn't reference hooks at all, so the dir is likely auto-discovered.

---

# Wave C — TDD + receiving-code-review

**Outline only.** Full plan to be authored when Wave B ships.

**New skills:**
- `plugins/p-flow/skills/test-driven-development/SKILL.md` — RED-GREEN-REFACTOR enforcement (port from `superpowers:test-driven-development`, retitle/adapt to p-flow voice).
- `plugins/p-flow/skills/receiving-code-review/SKILL.md` — how to process review findings rigorously (port + adapt).

**Modify:**
- `plugins/p-flow/skills/writing-plan/SKILL.md` — Plan template section: add second template variant ("TDD-aligned, default for code tasks") alongside current generic. Skill instructions detect "code task vs docs/research task" heuristically and pick the right template.
- `plugins/p-flow/skills/_shared/templates/` — possibly add `plan-tdd.template.md` if the second variant is large enough to factor out.
- `plugins/p-flow/README.md` — list the 2 new skills.

**Tests:**
- `tests/skills.test.ts` auto-picks up new skills.
- `tests/plugin-readme-coverage.test.ts` enforces README mention — passes if README updated.
- New (optional): `tests/p-flow-writing-plan-templates.test.ts` — assert the 2 plan template variants both exist and contain canonical sections.

**Release:** `v4.9.0`, `plugins/p-flow` `0.4.0` → `0.5.0` (minor — 2 new skills + behavioral change to writing-plan).

**Behavioural change risk:** existing users of `writing-plan` will see the TDD template offered by default for code tasks. Could surprise. Document migration note in README + RELEASE-NOTES.md (which lands in Wave D).

---

# Wave D — Cleanup batch (9 items)

**Outline only.** Full plan to be authored when Wave C ships.

| # | Item | Scope |
|---|---|---|
| D-1 | Q3 — task-end stay narrow + design note | Add `## Design note` block at top of `skills/task-end/SKILL.md` explaining the deliberate narrowing |
| D-2 | A-10 — Extract `using-git-worktrees` | New `skills/using-git-worktrees/SKILL.md`; `task-start --worktree` invokes it via `Skill tool` |
| D-3 | A-14 — Add `writing-skills` skill | New skill for contributing to the plugin (port from sp, adapt to p-flow's conventions) |
| D-4 | C-2 — Cleanup over-declared `allowed-tools` | task-brainstorming/writing-plan/verification-before-completion: remove unused tool declarations |
| D-5 | C-4 — Optionally rename `Agent` → `Task tool` in remaining places | Cosmetic alignment with superpowers terminology |
| D-6 | D-7 — Adopt Graphviz | Add `digraph` flow diagrams to `task-start` (Phase A/B branching) and `task-brainstorming` (precheck dispatch tree). 2 files. |
| D-7 | D-8 — "Announce at start" convention | Add `**Announce at start:** "I'm using the <name> skill to ..."` to top of all p-flow skill bodies. 8 files. |
| D-8 | B7 — Create `plugins/p-flow/RELEASE-NOTES.md` | Backfill release notes from v0.1.0 → current. ~50 lines. |
| D-9 | B10 — Create `plugins/p-flow/CLAUDE.md` | Contributor doc for p-flow plugin: agent-dispatch pattern, severity model, section conventions, plan/spec layout. |
| D-10 | A-2 — Add `dispatching-parallel-agents` skill | Port from sp; useful when `requesting-code-review` could dispatch both reviewers in parallel |

**Release:** `v4.10.0`, `plugins/p-flow` `0.5.0` → `0.6.0` (minor — adds skills + new convention).

**Note:** D-10 enables an *optimization* — running code-review and task-review in parallel from a single triage skill. Could land in a Wave E after if dispatching-parallel-agents proves useful.

---

# Skipped / explicitly NOT done

Per `parity.md` "What this audit explicitly recommends NOT doing":

- **Multi-host plugin manifests** (B3, B4, B6) — perky.team is Claude-Code-only.
- **`_shared/templates/` → colocated** (B5) — p-flow's centralized pattern is intentional + tested.
- **`writing-plan` rename → plural** (A-13, D-9 audit numbering) — breaking name change, no functional value.
- **`AskUserQuestion` / `TaskCreate` integrations** — both plugins agree they're not the right pattern.
- **`subagent-driven-development` skill fork** — use superpowers' canonical version.
- **`executing-plans` / `systematic-debugging` / `qa-brainstorming`** — Wave 2+ per original design spec.

---

# Self-review checklist (master plan)

- [ ] Each wave has clear scope + dependencies + release tag.
- [ ] Wave A is fully step-by-step actionable.
- [ ] Waves B–D are outlines + ready for follow-up detailed plans.
- [ ] Every gap from `parity.md` is either in a wave or in "Skipped" with rationale.
- [ ] No wave breaks an earlier-shipped invariant without acknowledgment.
- [ ] Each wave's release has a clear semver justification (minor vs patch).

# What this master plan deliberately does NOT do

- **Does not execute Waves B–D inline** — they're outlines; full step-level plans authored after Wave A ships, so we don't over-plan based on assumptions that change after Wave A.
- **Does not bundle waves into a single release.** Each wave is its own release for rollback safety; user can stop after any wave.
- **Does not modify the audit spec** — that doc is the historical record of *why* we're doing this work.
