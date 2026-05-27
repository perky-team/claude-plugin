# p-flow Wave C — TDD + receiving-code-review + writing-plan revamp

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Adopt the two missing discipline skills (`test-driven-development`, `receiving-code-review`) and revamp `writing-plan` to offer a TDD-aligned plan template for code tasks while keeping the generic template for docs/research. Closes audit gaps A-5, A-9, E4.

**Spec reference:**
- `plugins/p-flow/docs/specs/2026-05-27-superpowers-parity.md` — Dim A rows 5 + 9, Dim E pair E4.
- User decision Q2 in same spec: **partial adopt** — add the 2 skills; `writing-plan` offers TDD by default for code, generic for docs.

**Reference implementations:**
- `superpowers/skills/test-driven-development/SKILL.md` (371 lines, pedagogical) + `testing-anti-patterns.md` (299 lines).
- `superpowers/skills/receiving-code-review/SKILL.md` (213 lines).
- `superpowers/skills/writing-plans/SKILL.md` Task Structure section (canonical TDD task shape: 5 sub-steps — failing-test + verify-fails + implement + verify-passes + commit).

**Out of scope:**
- **Port superpowers' content verbatim.** We adapt to p-flow's procedural voice (Inputs/Procedure/Hard rules/Out of scope), not their pedagogical voice (Iron Law/Red Flags/Common Rationalizations). Net result: ~150 lines per new skill instead of 670 lines.
- **`testing-anti-patterns.md` companion file.** superpowers ships it; we don't. Reference superpowers' canonical anti-patterns in the body if useful.
- **`executing-plan` skill** — still Wave 2 per original design spec. TDD discipline applies when Claude manually walks plan.md steps; auto-execution is a separate wave.
- **Migrate existing plan.md files** in any repo. The skill writes NEW plans; existing ones stay as-is.

---

## Design decisions baked in

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **D1** | TDD skill length | **Lean (~150 lines)**, p-flow procedural voice (Inputs/Procedure/Hard rules/Out of scope/Red flags). No `testing-anti-patterns.md` companion. | Match existing p-flow skill voice; minimize maintenance burden. superpowers' 670 lines = framework-tier content; we want a focused discipline skill. |
| **D2** | receiving-code-review scope | **Hybrid** — primary path: `## Review follow-ups` items in `plan.md`. Secondary path: any external review (PR comment, AI agent, human inline feedback). | Aligns with how p-flow already produces review findings (Wave 1's `requesting-*-review` writes them into plan.md); still useful for ad-hoc reviews from elsewhere. |
| **D3** | Plan template location | **`_shared/templates/plan-generic.template.md` + `plan-tdd.template.md`** (centralized) | Matches the centralized template pattern already used for spec/feature/adr. The dead-template test auto-enforces both are referenced. Removes the inline-code-block template from writing-plan/SKILL.md → cleaner skill body. |
| **D4** | TDD detection in writing-plan | **Heuristic suggestion + explicit user confirmation** — skill reads the spec; if `feature.feature` exists OR AC mentions function/endpoint/class/script behaviors → suggest TDD. If spec is pure docs/research → suggest generic. Either way: **ask the user** before writing the plan. | Auto-detection can misclassify; user confirmation is the safety net. Asking via prose (not AskUserQuestion) — keeps consistency with our other dialog skills. |
| **D5** | TDD plan template Step shape | **Single checkbox per Step + bulleted sub-instructions** for RED-GREEN-REFACTOR. Each Step is `1. [ ] <action>` with bullets: `- **Test first**: ...`, `- **Implement**: ...`, `- **Verify**: ...`. No code embedded in template (template is structure, not concrete code). | Preserves `task-end` pre-check's `- [ ]` counting (each Step = 1 checkbox). superpowers' 5-sub-step shape would inflate counts 5× → all completeness warnings always fire. |
| **D6** | Update of `using-p-flow` | Add 2 new skills to its Skills table + brief mention that writing-plan offers 2 plan template variants. | Discovery skill must list everything the model can invoke. |
| **D7** | Backwards-compatibility | Existing plan.md files unchanged. New plans use the new templates. `task-end` semantics unchanged (per D5). | No migration burden on existing repos using p-flow. |
| **D8** | `/p-flow:init` scope | **Unchanged** — init still copies the 4 existing templates (rules, adr, feature-spec, specification). New plan templates stay INTERNAL to writing-plan (read from plugin bundle at plan-write time). | Avoids broadening init's blast radius and the init-e2e test surface. If per-repo customization of plan format becomes a real need, that's its own additive task. |

If you disagree with any — say so before Task 1 starts.

---

## File map

| File | Action | Task |
|---|---|---|
| `plugins/p-flow/skills/test-driven-development/SKILL.md` | create | 1 |
| `plugins/p-flow/skills/receiving-code-review/SKILL.md` | create | 2 |
| `plugins/p-flow/skills/_shared/templates/plan-generic.template.md` | create (extracted from current writing-plan inline) | 3 |
| `plugins/p-flow/skills/_shared/templates/plan-tdd.template.md` | create | 3 |
| `plugins/p-flow/skills/writing-plan/SKILL.md` | modify (detection logic + template refs; drop inline template) | 4 |
| `plugins/p-flow/skills/using-p-flow/SKILL.md` | modify (add 2 skills to table; mention TDD detection) | 5 |
| `plugins/p-flow/README.md` | modify (add 2 skills to table) | 6 |
| `plugins/p-flow/.claude-plugin/plugin.json` | modify (description + version bump) | 7 (release) |
| `.claude-plugin/marketplace.json` | modify (description) | 7 (release) |

---

## Task 1: Author `test-driven-development/SKILL.md`

**Goal:** ~150-line skill enforcing test-first discipline. Voice matches existing p-flow skills (verification-before-completion is the closest analog).

**Files:**
- Create: `plugins/p-flow/skills/test-driven-development/SKILL.md`

- [ ] **Step 1: Create dir + write file**

Sections (in order, p-flow procedural voice):

```markdown
---
name: test-driven-development
description: Use when about to write code (production code path, not docs/scripts/research) — enforces RED-GREEN-REFACTOR: write a failing test first, watch it fail, write minimal code to pass, verify pass, refactor. Pairs with verification-before-completion (this skill is "before code", verification is "before claiming done").
allowed-tools: Bash Read Write Edit Glob Grep
---

# test-driven-development

Before writing any production code, write a test that fails for the right reason. Then write the minimum code to make it pass. Then refactor with the test as a safety net.

## When to use

- About to add a new function / endpoint / class / handler / pipeline stage that has observable behavior.
- About to fix a bug — the regression test comes first, before the fix.
- About to refactor — characterization tests come first, before the refactor.

**Don't use when:**
- The change is pure documentation, scripts that are throwaway, or experimental research code where the goal is exploration, not durability.
- Tests would be tautological (e.g. wrapping a single 3rd-party call with no logic).

## Procedure (RED-GREEN-REFACTOR)

### RED — Write a failing test

1. Identify the smallest observable behavior the change should produce.
2. Write a test that asserts that behavior.
3. Run the test. **Expected: FAIL** with a message that names the missing thing (e.g. "ReferenceError: foo is not defined", "AssertionError: expected X got nothing").
4. **Quote the failure** in your response. The failure is evidence the test actually tests something.

If the test passes immediately → the test is wrong. Fix the test, not the code.

### GREEN — Write minimal code to pass

5. Write the smallest amount of code that makes the test pass. Hardcoded values are OK at this stage; the test will force generalization in the next iteration.
6. Run the test. **Expected: PASS.** Quote the pass.
7. Run the full test suite. **Expected: all green** (no regressions).

If the test still fails → the code doesn't solve the problem stated by the test. Don't add scaffolding around the test to make it pass; reconsider the implementation.

### REFACTOR — Clean up under test cover

8. Improve naming, extract helpers, remove duplication. The test is your safety net.
9. Run the test after each refactor step. If it goes red, the last refactor was incorrect — revert it.

## Hard rules

- **Never claim "tests pass" without running them.** This skill cannot be satisfied by intuition.
- **Never write the implementation before the test.** Even by one line. The test must exist and fail FIRST.
- **Never weaken the test to make it pass.** If the test is too strict, the implementation is wrong, not the test.
- **One test → one behavior.** Don't bundle assertions for unrelated behaviors into a single test.

## Red flags — STOP

- "I'll write the test after; let me just sketch the code first" → no.
- "The test will be obvious once the code exists" → no; write it first.
- "This change is too small for TDD" → if it has observable behavior, it gets a test.
- "I added an assertion but the test always passes" → the assertion is tautological; tighten it.

## What this skill does NOT do

- Does not run the test suite for you on completion claims — that's `verification-before-completion`.
- Does not write integration tests for systems you don't own (mock at the boundary; don't reach into 3rd-party state).
- Does not enforce test framework choice (use whatever the repo already uses).
- Does not apply when no test framework exists in the repo — say so and ask whether to bootstrap one or skip TDD for this change.
```

- [ ] **Step 2: Validate**

```bash
head -5 plugins/p-flow/skills/test-driven-development/SKILL.md
wc -c plugins/p-flow/skills/test-driven-development/SKILL.md
npm test -- tests/skills.test.ts 2>&1 | tail -3
```

Expected: frontmatter valid; file ~3 KB; skills.test.ts passes (151 → 158, +7 for new skill).

- [ ] **Step 3: Commit**

```bash
git add plugins/p-flow/skills/test-driven-development/SKILL.md
git commit -m "feat(p-flow): add test-driven-development skill (lean adaptation)"
```

---

## Task 2: Author `receiving-code-review/SKILL.md`

**Goal:** ~140-line skill enforcing rigor when processing review feedback (whether from `## Review follow-ups` in plan.md, a PR comment, or an inline AI agent reply).

**Files:**
- Create: `plugins/p-flow/skills/receiving-code-review/SKILL.md`

- [ ] **Step 1: Create dir + write file**

```markdown
---
name: receiving-code-review
description: Use when processing review feedback (a `## Review follow-ups` item in plan.md, a PR comment, an inline reviewer message) — enforces verify-the-finding-first discipline before implementing or rejecting. Counterpart to requesting-code-review.
allowed-tools: Bash Read Glob Grep Edit Write
---

# receiving-code-review

Treat every review finding as a hypothesis, not a directive. For each one: verify it's correct, decide whether to fix or push back with evidence, then act.

## When to use

- Working through a `## Review follow-ups — <date>` item in `specs/<slug>/plan.md`.
- A PR comment / inline review message lands and you're about to respond or implement.
- A subagent (or a human reviewer) returns findings and you need to action them.

## Inputs

- The finding itself (text + file:line citation if available).
- The code being reviewed.
- Optional: the spec / plan that motivated the change.

## Procedure

### 1. Verify the finding is correct

For each finding, ask:

- **Does the cited file:line actually contain what the finding describes?** Open it. Read it. If the citation is stale or wrong, the finding may be too.
- **Is the issue real, given the actual behavior of the code?** Run the relevant test. Check the actual flow. Don't take the reviewer's word for runtime behavior.
- **Does the suggested fix actually address the issue?** Sometimes a finding identifies a real symptom but proposes a wrong fix.

### 2. Classify

- **Valid + fix recommended.** Apply the fix.
- **Valid + alternative fix is better.** Propose the alternative; reply to the reviewer explaining the reasoning.
- **Invalid (false positive).** Reject with a one-line evidence-based reason. Don't argue tone, argue facts.
- **Unclear / can't reproduce.** Ask the reviewer for repro steps or a more specific citation. Don't guess.

### 3. Act per the classification

For each finding being **fixed**:
- Apply the fix.
- Run the relevant test (or write one if missing) to confirm the fix works AND nothing regresses.
- Quote the test pass in your response.

For each finding being **rejected**:
- If it's a `## Review follow-ups` item → mark the parent step `[x]` and add a one-line `> Rejected: <reason>` immediately below.
- If it's a PR comment → reply with the evidence-based reason.

For each finding being **deferred**:
- Add a `## Review decisions (audit)` bullet (same format `requesting-code-review` uses).

## Hard rules

- **Never blindly fix.** Every fix must be preceded by verification that the issue is real.
- **Never silently reject.** Every rejection must be explicit and recorded.
- **Never argue tone, argue facts.** "This is wrong" is not feedback; show evidence.
- **Reviewer might be wrong.** Both `code-reviewer` and `task-reviewer` agents have ~20% scope leakage on Sonnet (see plugins/p-flow/README.md "Known limitations") — read findings critically.

## Red flags — STOP

- "I'll just fix all the suggestions to be safe." No — blind fixes degrade the code.
- "The reviewer says X, so it must be X." Verify it.
- "I disagree but I'll fix it to avoid argument." No — explain the disagreement with evidence; let the reviewer correct your reasoning if you're wrong.

## What this skill does NOT do

- Does not dispatch a reviewer — that's `requesting-code-review` / `requesting-task-review`.
- Does not modify the reviewer prompt template — those are colocated with the requesting skills.
- Does not auto-close PR threads.
```

- [ ] **Step 2: Validate**

```bash
head -5 plugins/p-flow/skills/receiving-code-review/SKILL.md
npm test -- tests/skills.test.ts 2>&1 | tail -3
```

- [ ] **Step 3: Commit**

```bash
git add plugins/p-flow/skills/receiving-code-review/SKILL.md
git commit -m "feat(p-flow): add receiving-code-review skill"
```

---

## Task 3: Extract plan templates to `_shared/templates/`

**Goal:** Move the inline plan template from `writing-plan/SKILL.md` into 2 dedicated template files, one generic + one TDD-aligned.

**Files:**
- Create: `plugins/p-flow/skills/_shared/templates/plan-generic.template.md`
- Create: `plugins/p-flow/skills/_shared/templates/plan-tdd.template.md`

- [ ] **Step 1: Author `plan-generic.template.md`**

Copy the current inline template from `writing-plan/SKILL.md` `## Plan template` section, with the post-Wave-1.1 fix (no literal `...` markers):

```markdown
# Plan — {{SLUG}}

## Steps

1. [ ] <action — what to do>
   - **Acceptance**: <how to know this step is done — concrete and checkable>
   - **Files**: <expected affected files>

2. [ ] <action>
   - **Acceptance**: <how to know this step is done — concrete and checkable>
   - **Files**: <expected affected files>

## Open questions

- <questions that block or could change the plan>

## Risks

- <known risks, with mitigation if any>
```

- [ ] **Step 2: Author `plan-tdd.template.md`**

```markdown
# Plan — {{SLUG}}

> TDD plan: each Step follows RED-GREEN-REFACTOR. The skill `test-driven-development` enforces discipline for code Steps.

## Steps

1. [ ] <action — what behavior to add or change>
   - **Test first** (RED): <which test file + which assertion proves the behavior. Run; expect FAIL with: `<message>`>
   - **Implement** (GREEN): <minimal change in which files to make the test pass>
   - **Verify** (REFACTOR-safe): <which command to run; expect PASS + full suite still green>
   - **Acceptance**: <observable result; e.g. AC-1 + AC-2 satisfied>
   - **Files**: <test file + implementation file(s)>

2. [ ] <action>
   - **Test first** (RED): ...
   - **Implement** (GREEN): ...
   - **Verify** (REFACTOR-safe): ...
   - **Acceptance**: ...
   - **Files**: ...

## Open questions

- <questions that block or could change the plan>

## Risks

- <known risks, with mitigation if any>
```

- [ ] **Step 3: Validate dead-template check stays green**

Both new templates must be referenced by a SKILL.md, otherwise `tests/templates.test.ts` fails (dead-template check). Task 4 adds the references; until then this test will be red. Acceptable as an intermediate state — single landed commit at end of Task 4.

- [ ] **Step 4: Commit (intermediate — paired with Task 4)**

Hold; commit Task 3 + Task 4 together to keep tests green between commits.

---

## Task 4: Modify `writing-plan/SKILL.md` — detection + template refs

**Files:**
- Modify: `plugins/p-flow/skills/writing-plan/SKILL.md`

- [ ] **Step 1: Update frontmatter `allowed-tools`**

Already has `Read Write Edit Glob`. No change needed (template files are read via `Read`).

- [ ] **Step 2: Replace `## Procedure` to add detection step**

Insert between current steps 1 and 2 a new step:

```markdown
2. **Detect plan type and ask the user.**

   Examine the spec to suggest a type:
   - If `specs/<slug>/feature.feature` exists, OR `specification.md` Acceptance Criteria mention function / endpoint / class / handler / script behaviors → suggest **TDD plan** (template: `${CLAUDE_SKILL_DIR}/../_shared/templates/plan-tdd.template.md`).
   - Otherwise → suggest **generic plan** (template: `${CLAUDE_SKILL_DIR}/../_shared/templates/plan-generic.template.md`).

   Ask the user (in prose, no AskUserQuestion):
   *"Based on the spec, I'd suggest a **<TDD|generic>** plan. Confirm, or override with the other variant?"*

   Wait for explicit answer before proceeding.
```

Re-number subsequent steps (3, 4, 5).

- [ ] **Step 3: Replace `## Plan template` section with template references**

Replace the embedded code block with:

```markdown
## Plan templates

Two variants live in `_shared/templates/`:

- `plan-generic.template.md` — for docs / research / non-code tasks. Each Step has `Acceptance` + `Files`.
- `plan-tdd.template.md` — for code tasks (the default when behaviour testing is feasible). Each Step has `Test first` (RED) + `Implement` (GREEN) + `Verify` (REFACTOR-safe) + `Acceptance` + `Files`.

The skill reads the chosen template at runtime, substitutes `{{SLUG}}`, and writes it to `specs/<slug>/plan.md`.
```

- [ ] **Step 4: Update `## Hard gates` and `## Out of scope`**

Add to `## Out of scope`:
```markdown
- Does not enforce TDD discipline — that's the `test-driven-development` skill, invoked by Claude when actually writing code for a Step.
```

- [ ] **Step 5: Validate templates referenced + tests green**

```bash
grep "_shared/templates/plan-" plugins/p-flow/skills/writing-plan/SKILL.md
# Expected: both plan-generic.template.md and plan-tdd.template.md mentioned.

npm test -- tests/templates.test.ts tests/skills.test.ts 2>&1 | tail -3
# Expected: dead-template check passes (both templates referenced);
# writing-plan skill structure unchanged.
```

- [ ] **Step 6: Commit Tasks 3 + 4 together**

```bash
git add plugins/p-flow/skills/_shared/templates/plan-generic.template.md \
        plugins/p-flow/skills/_shared/templates/plan-tdd.template.md \
        plugins/p-flow/skills/writing-plan/SKILL.md
git commit -m "feat(p-flow): writing-plan offers TDD-aligned plan template for code tasks

Extracts the plan template from writing-plan/SKILL.md inline code block
into two centralized files in _shared/templates/:

- plan-generic.template.md  — action + acceptance + files (current shape)
- plan-tdd.template.md      — adds RED/GREEN/REFACTOR sub-instructions
                              per Step; single checkbox preserves task-end
                              completeness-counter semantics

writing-plan now detects plan type from the spec (feature.feature
present + AC mentions code behaviors → suggest TDD; else generic) and
asks the user to confirm before writing."
```

---

## Task 5: Update `using-p-flow/SKILL.md`

**Files:**
- Modify: `plugins/p-flow/skills/using-p-flow/SKILL.md`

- [ ] **Step 1: Add 2 new skills to the table**

Insert these rows into the `## Skills (model-invoked when context applies)` table:

```markdown
| `test-driven-development` | Before writing any production code (functions / endpoints / classes / handlers / bugfix code). Enforces RED-GREEN-REFACTOR: failing test first, then minimal code, then verify. |
| `receiving-code-review` | Before processing a review finding (a `## Review follow-ups` item, a PR comment, a reviewer reply). Enforces verify-the-finding-first; reject false positives explicitly. |
```

- [ ] **Step 2: Add a brief note about TDD detection in writing-plan**

In the `writing-plan` row, append: *"Offers a TDD-aligned template (default for code tasks) and a generic template (docs/research)."*

- [ ] **Step 3: Validate (skill body still ≤ ~3 KB, frontmatter intact, plugin-readme-coverage passes when README updated in Task 6)**

```bash
wc -c plugins/p-flow/skills/using-p-flow/SKILL.md
head -5 plugins/p-flow/skills/using-p-flow/SKILL.md
```

- [ ] **Step 4: Commit**

```bash
git add plugins/p-flow/skills/using-p-flow/SKILL.md
git commit -m "docs(p-flow): teach using-p-flow about TDD + receiving-code-review skills"
```

---

## Task 6: Plugin README

**Files:**
- Modify: `plugins/p-flow/README.md`

- [ ] **Step 1: Add 2 skills to the `## Skills (invoked by commands or context)` table**

Insert (in invocation-order):

```markdown
| `test-driven-development` | Before writing production code. Enforces RED-GREEN-REFACTOR (failing test first, minimal code, verify). Pairs with `verification-before-completion` ("before code" vs "before claiming done"). |
| `receiving-code-review` | Before processing review feedback (plan.md follow-ups, PR comments, reviewer replies). Verify the finding first; reject false positives with evidence. |
```

- [ ] **Step 2: (Optional) Add a note about plan template variants in the `## Spec directory layout` section**

After the existing tree description, add a one-line note:

```markdown
The `plan.md` file uses one of two templates from `_shared/templates/` — `plan-tdd.template.md` for code tasks (default) or `plan-generic.template.md` for docs/research. `writing-plan` asks the user which to use.
```

- [ ] **Step 3: Validate**

```bash
npm test -- tests/plugin-readme-coverage.test.ts 2>&1 | tail -3
# Expected: both new skills mentioned → green.
```

- [ ] **Step 4: Commit**

```bash
git add plugins/p-flow/README.md
git commit -m "docs(p-flow): document TDD + receiving-code-review skills + plan template variants"
```

---

## Task 7: Release

- [ ] **Step 1: Final validate + tests**

```bash
npm run validate
npm test 2>&1 | grep -E "Tests |Test Files " | head -2
```

Expected: validator green; test count rises by ~16 (2 new skills × 7 in skills.test.ts = 14; +2 README mentions in plugin-readme-coverage; +2 dead-template check additions in templates.test.ts; net ≈ 18). 709 → ≈ 727.

- [ ] **Step 2: Bump versions**

- `plugins/p-flow/.claude-plugin/plugin.json` `version`: `0.4.0` → `0.5.0` (minor — 2 new skills + behavioral change to writing-plan).
- Update both plugin.json + marketplace.json descriptions to include the 2 new skills.
- Marketplace tag: `v4.8.0` → **`v4.9.0`** (minor).

- [ ] **Step 3: Propose to user + confirm + tag**

> *"Proposed: **v4.9.0** (minor — adds `test-driven-development` + `receiving-code-review` skills; `writing-plan` now offers TDD-aligned plan template for code tasks. p-flow `0.4.0` → `0.5.0`. Backwards-compatible: existing plan.md files unchanged; new plans use the new templates. Confirm to proceed."*

Wait for explicit confirmation. Per CLAUDE.md: never tag silently.

- [ ] **Step 4: After confirmation — push + tag**

```bash
git add plugins/p-flow/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore(release): v4.9.0 — p-flow Wave C: TDD + receiving-code-review + plan template variants"
git push origin main
git tag v4.9.0
git push origin v4.9.0
```

---

## Self-review checklist

- [ ] `test-driven-development/SKILL.md` ≤ ~3 KB; voice matches p-flow style; covers RED-GREEN-REFACTOR.
- [ ] `receiving-code-review/SKILL.md` ≤ ~3 KB; voice matches p-flow style; documents the hybrid scope (plan.md + ad-hoc).
- [ ] Both plan templates exist in `_shared/templates/`; both are referenced by `writing-plan/SKILL.md`; dead-template check passes.
- [ ] `writing-plan/SKILL.md` has detection step that suggests + asks; references both templates via `${CLAUDE_SKILL_DIR}/../_shared/templates/...`.
- [ ] TDD template's Step shape uses single `- [ ]` checkbox per Step (preserves `task-end` semantics).
- [ ] `using-p-flow` lists both new skills + mentions TDD detection.
- [ ] `plugins/p-flow/README.md` has both new skills in the table.
- [ ] plugin.json + marketplace.json descriptions updated; version bumped to 0.5.0.
- [ ] `v4.9.0` tag created only after explicit user confirmation.

## What this Wave deliberately does NOT do

- **Does not port superpowers' pedagogical content** (Iron Law, Common Rationalizations, Real Examples sections). Our voice is procedural.
- **Does not ship `testing-anti-patterns.md` companion.** If needed later, that's its own additive task.
- **Does not modify the existing `verification-before-completion`** — it stays as the "before claiming done" gate; TDD is the "before writing code" gate. Complementary, separate.
- **Does not change `task-end` completeness-counter logic.** TDD template preserves single-checkbox-per-Step shape so the existing pre-check works unchanged.
- **Does not migrate existing plan.md files** in any consuming repo. Backwards-compatible.
- **Does not auto-invoke `test-driven-development` from `writing-plan`.** Detection lives in writing-plan; enforcement during execution is the user's invocation of TDD skill (or Wave 2's `executing-plan` once it ships).
