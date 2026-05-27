# p-flow — Tier 1 test coverage

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the structural test-coverage gaps surfaced by the smoke-test review (see `plugins/p-flow/docs/plans/2026-05-27-task-flow-followups.md`). Six small invariant checks that catch the kinds of drift we've already seen or almost seen.

**Out of scope (deferred):**

- **Tier 2 — executable-spec re-implementations** (`task-end` MR title deterministic rule, plan.md follow-up integration format, `task-start` Phase A conflict scan). Reasonable next wave; not urgent.
- **Tier 3 — behavioural validation of agent prompts.** Requires real LLM calls; flaky; cannot live in `npm test`. The manual smoke-test stays the only check for that surface.

**Precondition / coupled decision:**

Two uncommitted edits are in the tree from the smoke-test investigation:

- `plugins/p-flow/agents/code-reviewer.md` — strengthened "What is NOT your scope" + added §4 scope self-check.
- `plugins/p-flow/agents/task-reviewer.md` — symmetric edits.

Smoke-test on sonnet (production model) showed the patch is **partially effective**: false Blockers were eliminated (severity downgrade), but the agent still self-rationalized a plan/impl mismatch as a Suggestion. On haiku the patch had no effect.

Before this plan executes, the user must decide: **ship the partial fix** (recommended; closes the most-harmful case) or **revert both files**. Tests 4 + 5 of this plan assert structural invariants (read-only tools, presence of the negative-scope section) — those invariants hold on BOTH the patched and the pre-patch agents, so the tests work regardless of the choice. Default assumption: **ship the partial fix.** That decision happens in Task 0.

Note: a "third iteration with more explicit prompt examples" was considered and dropped — the current patch already combines strong negative wording (`MUST omit`) with an explicit self-check step. Further prompt tweaks would target sonnet's residual 20% slip, which manifests as a *Suggestion* (not Blocker) that self-rationalizes — acceptable. If the residual proves harmful in practice, the next step is structural ("restructure review skills" — separate plan), not more prompt tinkering.

**Spec reference:** none — these tests defend invariants already documented in `plugins/p-flow/docs/specs/2026-05-26-task-flow-design.md`. No spec changes.

---

## File map

| File | Action | Task |
|---|---|---|
| (decide on uncommitted agent edits) | review + commit-or-revert | 0 |
| `tests/p-flow-marker-consistency.test.ts` | extend | 1 |
| `tests/p-flow-cross-skill-consistency.test.ts` | create | 2 + 3 |
| `tests/agents.test.ts` | extend | 4 + 5 |
| `tests/plugin-readme-coverage.test.ts` | create | 6 |
| (commit/tag) | release | 7 |

---

## Task 0: Decide on the pending agent-scope edits

**Files (currently modified, uncommitted):**
- `plugins/p-flow/agents/code-reviewer.md`
- `plugins/p-flow/agents/task-reviewer.md`

- [ ] **Step 1: Surface the change diff to the user**

Run: `git diff plugins/p-flow/agents/`

Quote the diff (or the §"What is NOT your scope" + §Procedure deltas) and the sonnet smoke-test outcome:

> *"Before the patch (haiku): false Blocker on plan/impl mismatch. After the patch (sonnet): no Blocker; one Suggestion that mentions plan.md but self-labels as 'doc consistency'. Real code-quality findings preserved (relative-path, error swallowing, json format). Patch closes the worst-case false-Blocker; residual is acceptable."*

- [ ] **Step 2: Get explicit user direction**

Two options:
- (a) **Ship the partial fix.** Commit both agent files.
- (b) **Revert.** `git checkout plugins/p-flow/agents/`.

Wait for explicit answer. Do not commit until decided. Tests 4 + 5 (later in this plan) assert structural invariants that hold either way — no test re-design needed regardless of choice.

- [ ] **Step 3: Apply the decision**

(a) → `git add plugins/p-flow/agents/ && git commit -m "fix(p-flow): tighten scope discipline in reviewer agents"`. Continue with Task 1.

(b) → `git checkout plugins/p-flow/agents/`. Continue with Task 1.

---

## Task 1: `<branch-safe>` substitution unit test

Extend `tests/p-flow-marker-consistency.test.ts`. Currently it asserts the regex *shape* of the marker path in both skills. Add an algorithmic equivalence check: run the substitution and assert against expected output for representative branch names.

**Files:**
- Modify: `tests/p-flow-marker-consistency.test.ts`

- [ ] **Step 1: Add the substitution function + cases at the bottom of the existing describe block**

```typescript
// Algorithmic equivalence: confirm the / → __ rule produces the same path
// shape both skills document, for representative branch names.
const branchSafe = (b: string) => b.replaceAll('/', '__');

const cases: Array<[string, string]> = [
  ['feature/foo',         'feature__foo'],
  ['bugfix/abc/123',      'bugfix__abc__123'],
  ['main',                'main'],
  ['hotfix/CVE-2026-001', 'hotfix__CVE-2026-001'],
  ['',                    ''],
];

for (const [input, expected] of cases) {
  it(`branchSafe("${input}") → "${expected}"`, () => {
    expect(branchSafe(input)).toBe(expected);
  });
}
```

- [ ] **Step 2: Run**

`npm test -- tests/p-flow-marker-consistency.test.ts` — expect 10 tests pass (5 existing + 5 new).

- [ ] **Step 3: Commit**

```bash
git add tests/p-flow-marker-consistency.test.ts
git commit -m "test(p-flow): add branchSafe substitution cases to marker consistency test"
```

---

## Task 2 + 3: Cross-skill consistency (plan.md sections + branch types)

One new test file, two describe blocks.

**Files:**
- Create: `tests/p-flow-cross-skill-consistency.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const read = (rel: string) => readFileSync(join(repoRoot(), rel), 'utf-8');

// ----------------------------------------------------------------------------
// Plan.md canonical section names — per-file expected sets.
// Different skills reference different subsets of the canonical sections;
// each pair below is a contract. Drift in spelling or removal of an expected
// heading from the named file → test failure.

const PLAN_SECTION_CONTRACTS: Record<string, string[]> = {
  // writing-plan WRITES the initial template; references only the sections
  // it actually emits. `## Review follow-ups` / `## Review decisions (audit)`
  // are created lazily by the review skills, not by writing-plan.
  'plugins/p-flow/skills/writing-plan/SKILL.md': [
    '## Steps',
    '## Open questions',
    '## Risks',
  ],
  // Review skills append follow-ups and audit bullets, anchored relative to
  // `## Steps` and `## Open questions`.
  'plugins/p-flow/skills/requesting-code-review/SKILL.md': [
    '## Steps',
    '## Review follow-ups',
    '## Review decisions (audit)',
    '## Open questions',
  ],
  'plugins/p-flow/skills/requesting-task-review/SKILL.md': [
    '## Steps',
    '## Review follow-ups',
    '## Review decisions (audit)',
    '## Open questions',
  ],
  // task-end counts (Steps + Review follow-ups) and excludes (Open questions
  // + Risks + Review decisions). Mentions all five.
  'plugins/p-flow/skills/task-end/SKILL.md': [
    '## Steps',
    '## Review follow-ups',
    '## Review decisions (audit)',
    '## Open questions',
    '## Risks',
  ],
};

describe('p-flow plan.md section names consistency', () => {
  for (const [file, headings] of Object.entries(PLAN_SECTION_CONTRACTS)) {
    describe(file, () => {
      const content = read(file);
      for (const heading of headings) {
        it(`contains canonical heading "${heading}"`, () => {
          expect(content).toContain(heading);
        });
      }
    });
  }
});

// ----------------------------------------------------------------------------
// Branch type list — task-start declares the 5 types; task-end's slug
// resolution must accept all 5. Currently maintained in two places by hand.

const BRANCH_TYPES = ['feature', 'bugfix', 'hotfix', 'chore', 'docs'];

describe('p-flow branch type list consistency', () => {
  const taskStart = read('plugins/p-flow/skills/task-start/SKILL.md');
  const taskEnd   = read('plugins/p-flow/skills/task-end/SKILL.md');

  for (const t of BRANCH_TYPES) {
    it(`task-start mentions branch type "${t}"`, () => {
      expect(taskStart).toMatch(new RegExp(`\\b${t}\\b`));
    });
    it(`task-end mentions branch type "${t}"`, () => {
      expect(taskEnd).toMatch(new RegExp(`\\b${t}\\b`));
    });
  }
});
```

- [ ] **Step 2: Run**

`npm test -- tests/p-flow-cross-skill-consistency.test.ts` — expect 26 tests pass (16 plan-section contracts: 3 + 4 + 4 + 5; plus 10 branch-type checks: 5 × 2).

- [ ] **Step 3: Commit**

```bash
git add tests/p-flow-cross-skill-consistency.test.ts
git commit -m "test(p-flow): cross-skill consistency (plan sections + branch types)"
```

---

## Task 4: Agent `tools:` must not include Write or Edit

Add to existing `tests/agents.test.ts`. Defends the "read-only by design" invariant — losing it means a reviewer agent could accidentally edit code it was meant only to review.

**Files:**
- Modify: `tests/agents.test.ts`

- [ ] **Step 1: Add an `it()` inside the per-agent describe block**

Insert after the existing `frontmatter "tools" is a non-empty comma-separated string` check:

```typescript
it('frontmatter "tools" must NOT include Write or Edit (read-only)', () => {
  const v = agent.frontmatter.tools as string;
  const tools = v.split(',').map((t) => t.trim());
  expect(tools).not.toContain('Write');
  expect(tools).not.toContain('Edit');
});
```

- [ ] **Step 2: Run**

`npm test -- tests/agents.test.ts` — expect 16 tests pass (was 14: +1 per agent × 2 agents).

- [ ] **Step 3: Commit**

```bash
git add tests/agents.test.ts
git commit -m "test(agents): assert tools list excludes Write and Edit"
```

---

## Task 5: Agent must declare "What is NOT your scope" section

Same file extension. Defends the negative-scope discipline structure that we just strengthened during the smoke test. If someone deletes the section, this test fails.

**Files:**
- Modify: `tests/agents.test.ts`

- [ ] **Step 1: Add `it()` inside the per-agent describe block**

```typescript
it('body declares a "What is NOT your scope" section', () => {
  expect(agent.body).toContain('## What is NOT your scope');
});
```

- [ ] **Step 2: Run**

`npm test -- tests/agents.test.ts` — expect 18 tests pass (16 from Task 4 + 1 per agent × 2).

- [ ] **Step 3: Commit**

```bash
git add tests/agents.test.ts
git commit -m "test(agents): assert presence of 'What is NOT your scope' section"
```

---

## Task 6: Plugin README must mention every skill in its `skills/` directory

Catches doc rot — the kind that left p-flow's root README claiming "Skills: `init`." for weeks after task-flow Wave 1 shipped.

**Files:**
- Create: `tests/plugin-readme-coverage.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findPlugins, findSkills } from './helpers.js';

describe('plugin README skill coverage', () => {
  const plugins = findPlugins();

  for (const plugin of plugins) {
    const skills = findSkills(plugin.dir);
    if (skills.length === 0) continue;

    describe(`plugin: ${plugin.name}`, () => {
      it('README.md exists', () => {
        expect(existsSync(plugin.readmePath)).toBe(true);
      });

      const readme = readFileSync(plugin.readmePath, 'utf-8');

      for (const skill of skills) {
        it(`README mentions skill "${skill.name}"`, () => {
          // Tight match: require either backticked (`init`) or slash-command
          // (`/<plugin>:<skill>`) form. Bare-word match is rejected — short
          // skill names like `add` / `set` / `next` would false-positive on
          // unrelated prose (e.g. "add a destination" doesn't document the
          // /p-tasks:add skill).
          const ticked   = new RegExp('`' + skill.name + '`');
          const slashCmd = new RegExp(`/${plugin.name}:${skill.name}\\b`);
          const found = ticked.test(readme) || slashCmd.test(readme);
          expect(
            found,
            `README at ${plugin.readmePath} does not mention skill "${skill.name}" in backtick or slash-command form. Add it to the Skills/Commands table or remove the skill directory.`,
          ).toBe(true);
        });
      }
    });
  }
});
```

- [ ] **Step 2: Run**

`npm test -- tests/plugin-readme-coverage.test.ts`

Expected: passes (we just updated p-flow README to mention all 7 skills; p-wiki/p-tasks/p-statusline READMEs already enumerate their skills).

If any skill fails: that's a real gap — add to the README before shipping.

- [ ] **Step 3: Commit**

```bash
git add tests/plugin-readme-coverage.test.ts
git commit -m "test: assert plugin README mentions every skill in its skills/ dir"
```

---

## Task 7: Release

Per `wiki/.claude/CLAUDE.md`, tests + (possibly) docs = **patch**. If Task 0 chose option (a), this release also carries the agent scope-discipline fix — still patch (behavioural fix to agent prompt, no breaking API change).

**Files:** none modified in this task.

- [ ] **Step 1: Confirm clean state**

`npm run validate && npm test 2>&1 | tail -3` — validator passes; test count increased from 660 to ~720. Breakdown:

- +5 (Task 1: branchSafe substitution cases)
- +16 (Task 2: plan-section contracts: 3+4+4+5)
- +10 (Task 3: branch types × 2 skills)
- +2 (Task 4: agent tools-exclusion × 2 agents)
- +2 (Task 5: agent NOT-scope-section × 2 agents)
- +~23 (Task 6: 1 "README exists" per plugin with skills (4) + 1 per skill (19 total across all 4 plugins))

Total: ≈ **+58 → 718 passing.**

- [ ] **Step 2: Identify the next tag**

`git tag --list 'v*' --sort=-v:refname | head -1` → `v4.6.2`. Next patch: **`v4.6.3`**.

- [ ] **Step 3: Propose to the user**

If Task 0 was option (a):

> *"Proposed: **v4.6.3** (patch — agent scope-discipline fix + 6 structural tests; +~58 tests, baseline 660 → 718). No plugin.json bumps. Confirm."*

If Task 0 was option (b):

> *"Proposed: **v4.6.3** (patch — 6 structural tests; +~58 tests, baseline 660 → 718; no agent changes — reverted before this work). Confirm."*

Wait for explicit confirmation.

- [ ] **Step 4: After confirmation — tag and push**

```bash
git push origin main
git tag v4.6.3
git push origin v4.6.3
```

---

## Self-review checklist (for the engineer)

- [ ] Task 0 was resolved by the user before any test code was written.
- [ ] `npm run validate` exits 0.
- [ ] `npm test` exits 0; no pre-existing test regressed; new test count rose by ~58 (660 → 718 ± Task 6 plugin-coverage fluctuation).
- [ ] No flaky behavior on re-run.
- [ ] `feature/*` branch — none created; work landed straight on `main` (small docs/tests scope, matches previous follow-ups workflow). If the user prefers a branch, mention it before starting.
- [ ] `v4.6.3` tag exists locally and on origin (after user confirmation).

## What this plan deliberately does NOT touch

- **Tier 2 + Tier 3 tests** — separate plan.
- **The smoke-test report bug for haiku model** — bedrock LLM limitation; no prompt change can repair it. Documented in the smoke report; not actionable here.
- **The third-iteration prompt-tightening for code-reviewer** — only happens if the user picks Task 0 option (c), which spawns its own micro-plan.
- **Root README's still-stale Repository-layout tree (missing p-tasks and p-statusline entries)** — that's a separate doc-rot patch. Out of scope here.
