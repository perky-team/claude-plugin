# p-flow task flow — Wave 1 follow-ups

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the punch list of items genuinely deferred from Wave 1 (released as `v4.6.0` / `v4.6.1`): the stale root README, two real Minor findings from the final code review, and two additional test-coverage items proposed but not shipped.

**Out of scope (deferred):**

- **Task 12 smoke test from the Wave 1 plan** — manual; requires a separate Claude Code session in a scratch repo. Cannot run from this session.
- **Wave 2 skills** (`executing-plan`, `systematic-debugging`, `qa-brainstorming`) — separate plan; mentioned in the design spec, not part of this fix-up.

**Spec reference:** `plugins/p-flow/docs/specs/2026-05-26-task-flow-design.md` (unchanged). The Wave 1 plan's "Post-implementation amendments" section already captured the design refinements; this plan picks up the remaining cosmetic + coverage items.

**Items dropped after self-review of the first draft:**

- Trigger-phrase task for `code-reviewer` description — **false positive**: both `code-reviewer.md` and `task-reviewer.md` already end with `Use this agent from the \`requesting-<…>-review\` skill.`
- Severity-heading sing/plural alignment between the two agents — **misread**: the two agents use structurally different output formats (`code-reviewer` is severity-led, `task-reviewer` is category-led with severity counts in Summary). No drift to fix.
- `<placeholder>` → `{{PLACEHOLDER}}` conversion in `writing-plan`'s plan template — **scope-mistake**: the marker style is cosmetic; what actually triggers the skill's own self-review is the literal `...` in the template's second example step. Task refocused on removing only the `...` markers.

---

## File map

| File | Action | Task |
|---|---|---|
| `README.md` (repo root) | modify | 1 |
| `plugins/p-flow/skills/writing-plan/SKILL.md` | modify | 2 |
| `plugins/p-flow/README.md` | modify | 3 |
| `tests/p-flow-marker-consistency.test.ts` | create | 4 |
| `tests/p-flow-verification-e2e.test.ts` | create | 5 |
| (delete local branch) | cleanup | 6 |
| (commit/tag) | release | 7 |

---

## Task 1: Update root `README.md` p-flow section

The root README still says "Skills: `init`." for p-flow — that's the pre-Wave-1 surface. Bring it in line with what shipped.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Locate the p-flow section**

Run: `grep -n "^### \\[\`p-flow\`" README.md` — expect one match.

- [ ] **Step 2: Replace the p-flow section body**

Current paragraph reads:

```
Workflow rules for Claude: deny-permissions for secret files (`.env`, credentials), Conventional Commits + `<type>/<slug>` branch naming, and spec templates (ADR, Gherkin, full specification).

Skills: `init`.
```

Replace with:

```
Disciplined task development flow for Claude: secrets deny-list, Conventional Commits + `<type>/<slug>` branch naming, spec templates (ADR, Gherkin, full specification), and a skill+agent stack for brainstorm → plan → verify → review → push.

Commands: `init`, `task-start`, `task-end`.
Skills: `init`, `task-brainstorming`, `writing-plan`, `verification-before-completion`, `requesting-code-review`, `requesting-task-review`.
Subagents: `code-reviewer`, `task-reviewer`.
```

- [ ] **Step 3: Update the repository layout tree**

Find the line `│   └── p-flow/              ← workflow rules + spec templates`. The current tree shows only `.claude-plugin/`, `README.md`, `skills/` under `p-flow/`. Insert `agents/` and update the comment.

Amended fragment:

```
│   └── p-flow/              ← task development flow + spec templates
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── README.md
│       ├── agents/          ← read-only review subagents
│       ├── docs/superpowers/  ← per-plugin design spec + implementation plan
│       └── skills/
```

- [ ] **Step 4: Validate**

Run: `grep -A3 "^### \\[\`p-flow\`" README.md` — confirm the new paragraph lists task-start/task-end and mentions agents.

Run: `npm test 2>&1 | grep "marketplace" | head -5` — confirm the marketplace README-check test still passes (it asserts each plugin name appears in the first column of the plugins table; the row itself wasn't touched).

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: update root README p-flow section for task-flow Wave 1 surface"
```

---

## Task 2: `writing-plan` — drop literal `...` from the embedded plan template

The `writing-plan` skill writes a plan template with this snippet (line shown approximately):

```
1. [ ] <action — what to do>
   - **Acceptance**: <how to know this step is done — concrete and checkable>
   - **Files**: <expected affected files>

2. [ ] <action>
   - **Acceptance**: ...
   - **Files**: ...
```

The skill's own §4 self-review tells Claude to *"scan the produced file for placeholders (`TBD`, `TODO`, `...`)"*. The literal `...` in the second example step would falsely fire that self-review on any unedited template copy. Remove them by mirroring the first step's structure in the second.

(Note: `<action>` / `<…>` markers are NOT changed. They're cosmetic and read naturally in prose; they don't fire any rule in this skill.)

**Files:**
- Modify: `plugins/p-flow/skills/writing-plan/SKILL.md`

- [ ] **Step 1: Read the `## Plan template` section**

Run: `awk '/^## Plan template/,/^## Numbering/' plugins/p-flow/skills/writing-plan/SKILL.md`

Confirm two example steps (1 and 2), where step 2 has `...` on the `Acceptance` and `Files` lines.

- [ ] **Step 2: Apply the edit**

Inside the embedded `markdown` code block only, replace:

```
2. [ ] <action>
   - **Acceptance**: ...
   - **Files**: ...
```

with:

```
2. [ ] <action>
   - **Acceptance**: <how to know this step is done — concrete and checkable>
   - **Files**: <expected affected files>
```

- [ ] **Step 3: Validate**

Run: `grep -nE '^\\s*-\\s*\\*\\*(Acceptance|Files)\\*\\*: \\.\\.\\.' plugins/p-flow/skills/writing-plan/SKILL.md`

Expected: **zero matches** (no leftover `...` placeholders on Acceptance/Files lines).

Run: `npm test -- tests/skills.test.ts` — `writing-plan` skill block should remain green (frontmatter, name match, body > 100 chars; nothing relevant changed).

- [ ] **Step 4: Commit**

```bash
git add plugins/p-flow/skills/writing-plan/SKILL.md
git commit -m "docs(p-flow): drop literal '...' from writing-plan's example step"
```

---

## Task 3: p-flow plugin README — "auto-invoked" wording

The plugin README's table column header reads "Skills (auto-invoked)". In reality the skills fire on user phrasing or explicit invocation, not a cron-like auto-trigger. Reword.

**Files:**
- Modify: `plugins/p-flow/README.md`

- [ ] **Step 1: Locate and edit**

Find: `## Skills (auto-invoked)`
Replace with: `## Skills (invoked by commands or context)`

- [ ] **Step 2: Validate**

Run: `grep '^## Skills' plugins/p-flow/README.md` — expect the new heading.

- [ ] **Step 3: Commit**

```bash
git add plugins/p-flow/README.md
git commit -m "docs(p-flow): retitle Skills section — drop 'auto-invoked' overclaim"
```

---

## Task 4: Add marker-path consistency test

**Goal:** Defend against future drift where `verification-before-completion` and `task-end` disagree on the state-marker path.

**Files:**
- Create: `tests/p-flow-marker-consistency.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

// The canonical marker path: any drift between verification-before-completion
// and task-end will silently break the freshness check in task-end.
const MARKER_FRAGMENT = '.claude/.p-flow-state/';

describe('p-flow marker path consistency', () => {
  const verifPath = join(repoRoot(), 'plugins/p-flow/skills/verification-before-completion/SKILL.md');
  const endPath   = join(repoRoot(), 'plugins/p-flow/skills/task-end/SKILL.md');

  it('both skill files exist', () => {
    expect(existsSync(verifPath)).toBe(true);
    expect(existsSync(endPath)).toBe(true);
  });

  const verif = readFileSync(verifPath, 'utf-8');
  const end   = readFileSync(endPath,   'utf-8');

  it('verification-before-completion references the marker directory', () => {
    expect(verif).toContain(MARKER_FRAGMENT);
  });

  it('task-end references the same marker directory', () => {
    expect(end).toContain(MARKER_FRAGMENT);
  });

  it('both files agree on the <branch-safe>/last-verification suffix', () => {
    const SUFFIX = /\.claude\/\.p-flow-state\/<branch-safe>\/last-verification/;
    expect(SUFFIX.test(verif)).toBe(true);
    expect(SUFFIX.test(end)).toBe(true);
  });

  it('both files agree on the / → __ substitution rule', () => {
    const RULE = /`\/`.*`__`|`__`.*`\/`|`\/` in `<branch>` with `__`/;
    expect(RULE.test(verif)).toBe(true);
    expect(RULE.test(end)).toBe(true);
  });
});
```

- [ ] **Step 2: Run**

Run: `npm test -- tests/p-flow-marker-consistency.test.ts`

Expected: 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/p-flow-marker-consistency.test.ts
git commit -m "test(p-flow): assert verification marker path matches across skills"
```

---

## Task 5: Add `verification-before-completion` e2e test

**Goal:** Executable spec for the marker-write logic — mirrors `tests/p-flow-init-e2e.test.ts` (re-implements SKILL.md logic against a temp filesystem and asserts the resulting layout).

**Caveat (be honest about what this proves):** This is an *executable spec*, not a behaviour test. It validates that a TypeScript re-implementation of the marker-write rules behaves as documented. If `verification-before-completion/SKILL.md` changes, this test must change in lockstep — they're not coupled by anything but discipline. Same limitation as `p-flow-init-e2e.test.ts`, which is the convention we're following.

**Files:**
- Create: `tests/p-flow-verification-e2e.test.ts`

- [ ] **Step 1: Decide the algorithm to re-implement**

Per `verification-before-completion/SKILL.md` Procedure steps 5–7:

- On `tests pass + lint passes` → write marker; append `.gitignore` if needed.
- On `tests fail` → do NOT write marker; do NOT touch `.gitignore`.
- On `no tests detected` → do NOT write marker; do NOT touch `.gitignore`.

Marker path: `.claude/.p-flow-state/<branch-safe>/last-verification` where `<branch-safe>` = current branch with `/` → `__`.

`.gitignore` append (only on success, only if the directory line isn't already present):

```
# p-flow session state
.claude/.p-flow-state/
```

- [ ] **Step 2: Write the test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Re-implementation of verification-before-completion's marker logic.
type Outcome = { wroteMarker: boolean; markerPath?: string; gitignoreUpdated: boolean };

function branchSafe(branch: string): string {
  return branch.replaceAll('/', '__');
}

function applyVerification(
  repoRoot: string,
  branch: string,
  result: 'pass' | 'fail' | 'no-tests',
  testCommand?: string,
): Outcome {
  if (result !== 'pass') return { wroteMarker: false, gitignoreUpdated: false };

  const safe = branchSafe(branch);
  const markerDir = join(repoRoot, '.claude', '.p-flow-state', safe);
  const markerPath = join(markerDir, 'last-verification');
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(markerPath, `timestamp: ${new Date().toISOString()}\ncommands:\n  - ${testCommand} (exit 0)\n`);

  const gitignorePath = join(repoRoot, '.gitignore');
  const line = '.claude/.p-flow-state/';
  let updated = false;
  if (existsSync(gitignorePath)) {
    const cur = readFileSync(gitignorePath, 'utf-8');
    if (!cur.split('\n').some((l) => l.trim() === line)) {
      writeFileSync(gitignorePath, cur + (cur.endsWith('\n') ? '' : '\n') + '# p-flow session state\n' + line + '\n');
      updated = true;
    }
  } else {
    writeFileSync(gitignorePath, '# p-flow session state\n' + line + '\n');
    updated = true;
  }

  return { wroteMarker: true, markerPath, gitignoreUpdated: updated };
}

describe('p-flow verification-before-completion (e2e)', () => {
  let sandbox: string;
  beforeEach(() => { sandbox = mkdtempSync(join(tmpdir(), 'p-flow-verif-')); });
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }); });

  it('writes marker and creates .gitignore on pass when no .gitignore exists', () => {
    const r = applyVerification(sandbox, 'feature/foo', 'pass', 'npm test');
    expect(r.wroteMarker).toBe(true);
    expect(existsSync(r.markerPath!)).toBe(true);
    expect(r.markerPath).toContain(join('.claude', '.p-flow-state', 'feature__foo', 'last-verification'));
    const gi = readFileSync(join(sandbox, '.gitignore'), 'utf-8');
    expect(gi).toContain('.claude/.p-flow-state/');
    expect(gi).toContain('# p-flow session state');
  });

  it('appends to existing .gitignore exactly once on pass', () => {
    writeFileSync(join(sandbox, '.gitignore'), 'node_modules/\n');
    applyVerification(sandbox, 'feature/foo', 'pass', 'npm test');
    applyVerification(sandbox, 'feature/foo', 'pass', 'npm test');
    const gi = readFileSync(join(sandbox, '.gitignore'), 'utf-8');
    const occurrences = gi.split('\n').filter((l) => l.trim() === '.claude/.p-flow-state/').length;
    expect(occurrences).toBe(1);
    expect(gi).toContain('node_modules/');
  });

  it('does NOT write marker or touch .gitignore on test failure', () => {
    const r = applyVerification(sandbox, 'feature/foo', 'fail');
    expect(r.wroteMarker).toBe(false);
    expect(existsSync(join(sandbox, '.claude', '.p-flow-state'))).toBe(false);
    expect(existsSync(join(sandbox, '.gitignore'))).toBe(false);
  });

  it('does NOT write marker or touch .gitignore when no tests detected', () => {
    const r = applyVerification(sandbox, 'feature/foo', 'no-tests');
    expect(r.wroteMarker).toBe(false);
    expect(existsSync(join(sandbox, '.claude', '.p-flow-state'))).toBe(false);
    expect(existsSync(join(sandbox, '.gitignore'))).toBe(false);
  });

  it('substitutes / → __ in branch name for the marker path', () => {
    const r = applyVerification(sandbox, 'bugfix/abc/123', 'pass', 'npm test');
    expect(r.markerPath).toContain(join('.claude', '.p-flow-state', 'bugfix__abc__123', 'last-verification'));
  });
});
```

- [ ] **Step 3: Run**

Run: `npm test -- tests/p-flow-verification-e2e.test.ts`

Expected: 5 tests pass.

- [ ] **Step 4: Cross-check the re-implementation against the live SKILL.md**

Open `plugins/p-flow/skills/verification-before-completion/SKILL.md` steps 5–7 and walk each rule against the test code in Step 2. If SKILL.md says something the test doesn't model (e.g. ISO-8601 timestamp formatting is not asserted) — that's an intentional simplification, document it in a code comment if non-obvious.

- [ ] **Step 5: Commit**

```bash
git add tests/p-flow-verification-e2e.test.ts
git commit -m "test(p-flow): add e2e for verification-before-completion marker logic"
```

---

## Task 6: Cleanup — delete the stale local feature branch

**Files:** none.

- [ ] **Step 1: Confirm the branch is merged into main**

Run: `git branch --merged main | grep p-flow-task-flow`

Expected: shows the branch (it was fast-forwarded into main).

- [ ] **Step 2: Delete**

```bash
git branch -d feature/p-flow-task-flow
```

(Lowercase `-d` refuses unmerged — safer than `-D`.)

- [ ] **Step 3: No commit, no push**

The branch was never pushed to origin. Local cleanup only.

---

## Task 7: Release — patch bump

Per `wiki/.claude/CLAUDE.md`, docs + tests + minor fixes pair with a **patch** semver tag.

**Files:** none modified in this task; tag created at push time.

- [ ] **Step 1: Confirm current state**

Run: `npm run validate && npm test 2>&1 | tail -3`

Expected: validator passes; tests green; no regressions.

- [ ] **Step 2: Identify the next marketplace tag**

Run: `git tag --list 'v*' --sort=-v:refname | head -1`

Expected: `v4.6.1`. Next patch: **`v4.6.2`**.

- [ ] **Step 3: Propose to the user**

State: *"Proposed release tag: **v4.6.2** (patch — root README accuracy, two doc fixes, two new tests, branch cleanup). No plugin behaviour changed; no plugin.json bumps. Confirm to proceed."*

Wait for explicit confirmation. Per repo rule: never tag silently.

- [ ] **Step 4: After confirmation — tag and push**

```bash
git push origin main
git tag v4.6.2
git push origin v4.6.2
```

---

## Self-review checklist (for the engineer)

Before declaring done:

- [ ] `npm run validate` exits 0.
- [ ] `npm test` exits 0; new tests appear in output (`p-flow marker path consistency`, `p-flow verification-before-completion (e2e)`); test count rises by ~10 (5 + 5).
- [ ] Root README's p-flow row reflects the full surface (init/task-start/task-end + 5 skills + 2 agents).
- [ ] `plugins/p-flow/README.md` no longer says "auto-invoked".
- [ ] `writing-plan/SKILL.md`'s Plan template no longer contains lines like `- **Acceptance**: ...` or `- **Files**: ...`.
- [ ] No stray uncommitted changes.
- [ ] `v4.6.2` tag exists locally and on origin (only after user confirmation).
- [ ] Local branch `feature/p-flow-task-flow` is deleted.

## What this plan deliberately does NOT touch

- **Task 12 smoke test** from Wave 1 — manual; requires interactive Claude Code session against a scratch repo. Stays on the user's queue.
- **Wave 2 skills** (`executing-plan`, `systematic-debugging`, `qa-brainstorming`) — separate plan, separate release. Mentioned in the design spec §6.
- **`verification-before-completion` allowed-tools `Bash` (unconstrained)** — flagged as Minor 8; intentional because the test runner is unknown a priori. No change.
- **`task-start` worktree → `git -C`-everywhere alternative contract** — Wave 1 settled on "stop after creating worktree; user opens new session". Revisit only if real usage proves the hand-off too clunky.
- **`<placeholder>` vs `{{PLACEHOLDER}}` marker style across templates** — cosmetic-only; no rule fires on either. Out of scope unless a future skill needs to programmatically substitute markers (would force a standard).
- **Trigger-phrase amendments to agent descriptions** — verified both already include the phrase; original review finding was a false positive.
- **Severity-heading sing/plural alignment between the two agents** — verified the two agents use structurally different output formats by design; no drift exists.
