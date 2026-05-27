# `/p-flow:init` — Phase 2 brainstorm implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Extend `/p-flow:init` with a second phase — a brainstorm dialog at the repo level that captures vision + feature decomposition, then materialises one stub `specs/<slug>/specification.md` per identified feature. No new skill, no `specs/repo.md`, no roadmap file. After init, the standard per-feature workflow (`/p-flow:task-start`, `task-brainstorming`) handles everything: adding new features, refining existing stubs, dropping (manual).

**Architecture:** State-machine guard on entry — init's behaviour is determined by what's on disk:

| `.claude/rules/p-flow.md` | `specs/*/` feature folders | Behaviour |
|---|---|---|
| missing | empty | run Phase 1 (scaffolding) + Phase 2 (brainstorm) |
| exists | empty | skip Phase 1 silently, run Phase 2 only (resume interrupted dialog) |
| exists | ≥ 1 folder | refuse — fully initialised |
| missing | ≥ 1 folder | refuse — inconsistent state, user resolves manually |

Phase 2 is a one-question-at-a-time dialog that closes vision / problem / users / out-of-scope / feature list, then writes folders + stub specs. Each stub is the `specification.template.md` shape with metadata + problem + user story + 1-3 high-level acceptance bullets filled; deeper sections (Technical Design, NFRs, Migration, etc.) stay as `{{PLACEHOLDERS}}` for later `task-brainstorming` refinement.

**Tech Stack:** Markdown SKILL edits, Bash for git/test/mkdir, Read/Write/AskUserQuestion. No new runtime dependencies. Vitest for the existing test suite.

**Spec reference:** Conversation 2026-05-27 — agreed scope: extend init only, no separate skill, no roadmap file, refuse semantics from state machine above.

---

## File map

| # | Path | Action | Task |
|---|---|---|---|
| 1 | `plugins/p-flow/skills/init/SKILL.md` | rewrite Step 2 + add Phase 2 + update Step 6 | 1 |
| 2 | `plugins/p-flow/skills/using-p-flow/SKILL.md` | modify init row | 2 |
| 3 | `plugins/p-flow/README.md` | modify init description | 3 |
| 4 | `plugins/p-flow/CLAUDE.md` | add architecture-decision row | 3 |
| 5 | `plugins/p-flow/.claude-plugin/plugin.json` | bump version + update description | 4 |
| 6 | `plugins/p-flow/RELEASE-NOTES.md` | prepend v0.7.0 section | 4 |
| 7 | `plugins/p-flow/tests/` (run) | verify suite | 5 |

---

## Task 1 — Rewrite `init/SKILL.md`

**Files:**
- Modify: `plugins/p-flow/skills/init/SKILL.md` (whole file structure changes — easier to specify as a full replacement than diff chunks).

- [ ] **Step 1: Update frontmatter.** Replace lines 1–6 with:

```markdown
---
name: init
description: Initialize Claude-Code workflow rules in the current repo AND brainstorm the initial high-level feature breakdown. Phase 1 — scaffold `.claude/settings.json` (secret deny-list), `.claude/rules/p-flow.md`, and four templates under `.claude/templates/p-flow/`. Phase 2 — dialog with the user to identify vision + features, then create `specs/<slug>/specification.md` stubs for each. Use when the user says "init p-flow", "setup p-flow", or asks to bootstrap a new repo.
argument-hint: (no arguments)
allowed-tools: Bash(git rev-parse:*) Bash(mkdir:*) Bash(test:*) Bash(ls:*) Read Write
---
```

- [ ] **Step 2: Replace Step 2 ("Refuse if already initialised") with a state machine.** Replace lines 20–26 with:

````markdown
## Step 2 — State-machine gate

Detect repo state via Bash:

```bash
test -f "<root>/.claude/rules/p-flow.md" && echo "rules:yes" || echo "rules:no"
ls "<root>/specs/" 2>/dev/null | grep -v '^_' | head -1 && echo "specs:yes" || echo "specs:no"
```

(The `grep -v '^_'` excludes any future archive-style folders prefixed with underscore. `head -1` short-circuits — any one feature folder means "specs:yes".)

Branch on the result:

| rules | specs | Action |
|---|---|---|
| no | no | Run **Phase 1** (Steps 3–5) then **Phase 2** (Steps 6–7). Greenfield path. |
| yes | no | **Skip Phase 1.** Tell the user: *"Scaffolding already in place. Resuming with the feature brainstorm."* Then run Phase 2 only. |
| yes | yes | **Refuse.** Tell the user: *"p-flow is already initialised and at least one feature spec exists under `specs/`. To add a new feature use `/p-flow:task-start <type>/<slug>`. To regenerate everything from scratch, delete `.claude/rules/p-flow.md` AND all `specs/<slug>/` folders manually first."* Stop. |
| no | yes | **Refuse.** Tell the user: *"Inconsistent state: feature folders exist under `specs/` but the p-flow rules file is missing. Resolve manually — either restore `.claude/rules/p-flow.md` (e.g. via git) or remove the orphaned `specs/<slug>/` folders — then re-run."* Stop. |

Do **not** check for `.claude/settings.json` as a marker — it may exist for unrelated reasons.
````

- [ ] **Step 3: Renumber existing Steps 3, 4, 5 to be the body of Phase 1.** Insert a `## Phase 1 — Scaffolding` heading right above the current "Step 3 — Create directories" line. Then add `## Phase 2 — Feature brainstorm` between current Step 5 (settings merge) and current Step 6 (final message).

The Phase 2 section, inserted after Step 5 and before Step 6:

````markdown
## Phase 2 — Feature brainstorm

This phase produces `specs/<slug>/specification.md` stubs for each feature the user wants in the initial cut.

### Step 6 — Offer to skip

Use `AskUserQuestion`:

> **Brainstorm the initial feature list?** This takes 5–15 minutes of back-and-forth. You can also skip and add features later with `/p-flow:task-start`.

Options (single-select):
- **Yes, brainstorm now** — proceed to Step 7.
- **Skip — I'll add features later** — jump straight to the final message (Step 10).

### Step 7 — Dialog

**One question at a time.** Adapt depth to what the user already volunteers — if they answered something in their first message, don't re-ask.

Sequence (skip a question if already covered):

1. **Vision.** "In one sentence — what does this project exist to do, and for whom?"
2. **Problem.** "What concrete problem does it solve? Why does this matter to those users?"
3. **Users.** "Who specifically uses it? Roles, not 'everyone'. List the 1–3 main actors."
4. **Out of scope.** "What is the project deliberately NOT going to do? (Even one or two non-goals helps prevent later drift. Skip if nothing comes to mind.)"
5. **Feature decomposition.** "Based on what you've said, here's an initial cut of features I'd propose: [list 3–7 candidates with kebab-case slugs + one-line summaries]. Edit / add / remove / confirm?"
   - Iterate until the user is satisfied.
   - Cap at ~10 features. If the user wants more, push back: *"That's a lot for an initial cut — usually a sign the project should be split or some of these are sub-features. Want to merge any?"*
6. **Per-feature drill** — for each agreed feature, in one short message: "For `<slug>`, give me 1–3 acceptance bullets at the highest level — what does success look like? (Detail comes later via `task-brainstorming` when you start the work.)" Capture user response. If the user just says "skip" or "we'll figure it out later", proceed with empty acceptance criteria — the stub will leave that placeholder for later refinement.

**Hard gate:** do NOT move to Step 8 until the user explicitly approves the final feature list. Use a closing message like *"Final list: [slugs]. Confirm and I'll create the stub specs."*

### Step 8 — Validate slugs

For each agreed slug, enforce:
- kebab-case, lowercase
- `[a-z0-9-]+` only
- ≤ 50 characters
- not empty

If any slug violates: tell the user which ones, propose corrections, re-confirm. Do NOT silently rewrite.

### Step 9 — Materialise stubs

For each agreed feature:

1. Run `mkdir -p <root>/specs/<slug>/` via Bash.
2. If `<root>/specs/<slug>/specification.md` already exists with non-trivial content (e.g. user pre-created folders before running init) — refuse to overwrite. Tell the user which slugs collided and ask whether to skip those or abort. Default action on user uncertainty: skip the colliding ones, materialise the rest.
3. Read `${CLAUDE_SKILL_DIR}/../_shared/templates/specification.template.md` (or `<root>/.claude/templates/p-flow/specification.md` — both are identical at this point, since Phase 1 just copied it). Fill the following placeholders from the dialog:
   - `{{FEATURE_TITLE}}` — human-readable title (capitalize first letter of summary).
   - `{{FEATURE_NAME}}` — the slug.
   - `{{ONE_LINE_DESCRIPTION}}` — the one-line summary.
   - `{{STATUS}}` — literal string `planned`.
   - `{{DATE}}` — today's date in `YYYY-MM-DD`.
   - `{{AUTHOR}}` — leave empty or fill from `git config user.name` if easily available.
   - `{{PROBLEM_STATEMENT}}` — derived from the project-level Problem (Step 7 question 2) narrowed to what this feature addresses. 1–3 sentences. If unclear from dialog, leave the placeholder literal.
   - `{{USER_STORY}}` — *"As a <target user>, I want <one-line summary>, so that <project-level problem narrowed to this feature>."* Best-effort; leave placeholder if dialog didn't yield enough.
   - `{{ACCEPTANCE_CRITERIA}}` — the 1–3 bullets captured in Step 7 question 6, as a markdown bulleted list. If user said "skip", leave the placeholder literal.
4. **Every other `{{PLACEHOLDER}}`** in the template — leave literal. `task-brainstorming`'s refine-mode (`task-brainstorming/SKILL.md:41` — "resume filling / discard and restart / cancel") will fill them later when the user runs `/p-flow:task-start feature/<slug>`.
5. Write the file. Format: preserve template formatting verbatim; no extra blank lines or trailing whitespace introduced.

After all features materialised: confirm to the user how many stubs were written and where.
````

- [ ] **Step 4: Replace Step 6 ("Final message")** — renumber to **Step 10** and expand to cover the new artifacts. Replace the existing Step 6 (lines 72–81) with:

```markdown
## Step 10 — Final message

Tell the user, in this order:

1. **If Phase 1 ran:** where the rules file was written (`<root>/.claude/rules/p-flow.md`) and where the templates live (`<root>/.claude/templates/p-flow/` — four files: `adr.md`, `feature-spec.feature`, `specification.md`, and the deny-list status of `.claude/settings.json`).
   - **If `settings.json` was created fresh:** "Created with the full p-flow deny list."
   - **If merged:** list the deny patterns that were **newly added**. If every template pattern was already present, say explicitly: "No new entries added — the existing file already covered every deny pattern from the template."
2. **If Phase 2 ran AND produced stubs:** list the feature slugs and their paths. Example:
   > "Created 4 feature stubs:
   > - `specs/user-auth/specification.md`
   > - `specs/dashboard/specification.md`
   > - `specs/billing/specification.md`
   > - `specs/notifications/specification.md`
   >
   > Run `/p-flow:task-start feature/<slug>` when you're ready to start work on one — `task-brainstorming` will resume filling the placeholders in its refine-mode."
3. **If Phase 2 was skipped:** *"Brainstorm skipped. When ready, use `/p-flow:task-start <type>/<slug>` for each new feature — it creates the branch and runs `task-brainstorming` automatically."*
4. One-line reminder: *"Conventional Commits (`<type>(<scope>)?: <subject>`) and `<type>/<slug>` branches are now the rule in this repo. Full details in `.claude/rules/p-flow.md`."*
```

- [ ] **Step 5: Update the Edge cases section** at the bottom. Replace it (lines 83–89) with:

```markdown
## Edge cases

- **`mkdir -p` fails** (e.g. permissions) → stop, show the exact error from the shell.
- **A template file can't be read** (`${CLAUDE_SKILL_DIR}/../_shared/templates/X` missing) → stop and tell the user the plugin install may be corrupted.
- **`.claude/settings.json` exists but is invalid JSON** → stop, ask user to fix and retry (covered in Step 5 Case B).
- **`permissions` / `permissions.deny` of wrong shape** → stop with a clear error (covered in Step 5 Case B).
- **User interrupts mid-dialog in Phase 2** → no rollback. Folders created so far stay. On re-run, the state machine (Step 2) will detect "rules:yes, specs:yes" if any stub was written and refuse — the user has to delete the partial `specs/<slug>/` folders manually to resume. This is acceptable: a partial brainstorm is rare, and explicit cleanup beats implicit overwrite.
- **`git config user.name` not set** → leave `{{AUTHOR}}` empty in stubs; don't prompt.
- **Phase 2 dialog produces 0 features** (user said skip on the decomposition question) → write no stubs, jump to Step 10 with the "Phase 2 was skipped" message variant.
```

- [ ] **Step 6: Commit.**

```bash
git add plugins/p-flow/skills/init/SKILL.md
git commit -m "feat(p-flow): init adds Phase 2 — repo-level feature brainstorm + stub specs"
```

---

## Task 2 — Update `using-p-flow/SKILL.md`

**Files:**
- Modify: `plugins/p-flow/skills/using-p-flow/SKILL.md:24` (init command row)

- [ ] **Step 1: Replace the init row in the Slash commands table.**

Old (line 24):

```markdown
| `/p-flow:init` | Bootstrap p-flow rules + templates + secret-deny-list into the current repo. One-time per repo. |
```

New:

```markdown
| `/p-flow:init` | Bootstrap p-flow into a new repo. Phase 1 — scaffold rules + templates + secret-deny-list. Phase 2 — brainstorm the initial feature list and create `specs/<slug>/specification.md` stubs. One-time per repo (state-machine guard; refuses if `specs/<slug>/` already exist). |
```

- [ ] **Step 2: Commit.**

```bash
git add plugins/p-flow/skills/using-p-flow/SKILL.md
git commit -m "docs(p-flow): using-p-flow — init now does Phase 2 brainstorm"
```

---

## Task 3 — Update `README.md` + `CLAUDE.md`

**Files:**
- Modify: `plugins/p-flow/README.md` (init description in the Commands section)
- Modify: `plugins/p-flow/CLAUDE.md` (architecture decisions table)

- [ ] **Step 1: Read `plugins/p-flow/README.md`** to find the init entry. Replace its description to match this template (preserve whatever format the README uses — table cell, list item, etc.):

> *Bootstrap p-flow into a new repo. Phase 1 — scaffold rules, templates, secret-deny-list. Phase 2 — brainstorm initial feature list with the user and create stub specs in `specs/<slug>/`. One-time per repo (state-machine guard).*

- [ ] **Step 2: Add a row to `plugins/p-flow/CLAUDE.md`'s architecture decisions table** (the one starting `| Decision | Wave | Doc |`):

```markdown
| `/p-flow:init` extended with Phase 2 — a repo-level feature brainstorm that materialises stub `specs/<slug>/specification.md` files. No new skill (kept inside `init`); no `specs/roadmap.md` or `specs/repo.md` feature index — folders are canonical, `task-brainstorming` refine-mode handles deeper work. State-machine guard on re-run: refuse iff any `specs/<slug>/` folder exists. | E | `docs/plans/2026-05-27-init-brainstorm-phase.md` |
```

- [ ] **Step 3: Commit.**

```bash
git add plugins/p-flow/README.md plugins/p-flow/CLAUDE.md
git commit -m "docs(p-flow): README + CLAUDE.md — init Phase 2 brainstorm"
```

---

## Task 4 — Version bump + RELEASE-NOTES

**Files:**
- Modify: `plugins/p-flow/.claude-plugin/plugin.json:3-4`
- Modify: `plugins/p-flow/RELEASE-NOTES.md` (prepend new section)

- [ ] **Step 1: Bump version 0.6.0 → 0.7.0** — minor (additive behaviour to existing command, no breakage).

Replace lines 3–4 of `plugin.json`:

```json
  "version": "0.7.0",
  "description": "Disciplined task development flow for Claude Code: secrets deny-list, Conventional Commits + <type>/<slug> branches, spec templates, and a skill stack for brainstorm → plan → TDD → verify → review → push (review skills dispatch general-purpose subagents with inline reviewer templates). Commands: init (Phase 1 scaffolding + Phase 2 feature brainstorm), task-start, task-end. Skills: using-p-flow, init, task-brainstorming, writing-plan (TDD-aligned or generic plan templates), test-driven-development, verification-before-completion, requesting-code-review, requesting-task-review, receiving-code-review, using-git-worktrees, writing-skills. Discoverable via SessionStart hook. See plugins/p-flow/CLAUDE.md for contributor docs.",
```

- [ ] **Step 2: Prepend the v0.7.0 release notes section** to `plugins/p-flow/RELEASE-NOTES.md`, right after the line-3 preamble blockquote (line 4 is currently a blank — insert above the existing `## v4.10.0` heading). Use this exact content:

```markdown
## v?.?.? — `plugins/p-flow 0.7.0` — 2026-05-27 — `/p-flow:init` Phase 2 brainstorm

- `/p-flow:init` now runs in two phases. Phase 1 is the existing scaffolding (rules + templates + settings merge). Phase 2 is a new repo-level brainstorm dialog that captures vision / problem / users / out-of-scope and identifies an initial feature list, then materialises one stub `specs/<slug>/specification.md` per agreed feature.
- Each stub is the standard `specification.template.md` with metadata + problem + user story + 1–3 acceptance bullets filled. Deeper sections stay as `{{PLACEHOLDERS}}` and are resumed later by `task-brainstorming`'s refine-mode when the user runs `/p-flow:task-start feature/<slug>`.
- State-machine guard on entry replaces the previous unconditional refuse:
  - rules missing + specs empty → run both phases (greenfield).
  - rules present + specs empty → skip Phase 1, run Phase 2 only (resume interrupted dialog).
  - specs has ≥ 1 folder → refuse (use `/p-flow:task-start` for new features).
  - rules missing + specs present → refuse (inconsistent state; user resolves).
- Phase 2 is skippable via `AskUserQuestion` for users who prefer to add features ad-hoc.
- **No new skill, no `specs/repo.md`, no roadmap file.** Folders remain the canonical source of truth. Adding / refining / dropping features later uses the existing `task-start` + `task-brainstorming` workflow (drop = user manually sets `Status: dropped` in the spec frontmatter).
- **No breaking changes.** Existing initialised repos are protected by the state-machine guard's "refuse if specs exist" rule — no risk of overwriting stubs or specs.

> Marketplace tag will be assigned at push time per the repo's release rules in `.claude/CLAUDE.md`.
```

- [ ] **Step 3: Commit.**

```bash
git add plugins/p-flow/.claude-plugin/plugin.json plugins/p-flow/RELEASE-NOTES.md
git commit -m "chore(release): p-flow 0.7.0 — init Phase 2 brainstorm"
```

---

## Task 5 — Run tests + verify

**Files:**
- Run: project test suite (`npm test` or equivalent — confirm from `package.json`)

- [ ] **Step 1: Identify the test runner.** Read `package.json` at the repo root; quote the exact `test` script.

- [ ] **Step 2: Run the suite.** Expected: all green.

Tests that exercise this change:
- `tests/skills.test.ts` — re-validates the `init` SKILL.md frontmatter (name, description ≥ 30 chars, body > 100 chars, allowed-tools parseable). The new frontmatter is longer and adds `Bash(ls:*)` — both fine.
- `tests/templates.test.ts` — every template in `_shared/templates/` must be referenced. `specification.template.md` is now referenced by `init` (Phase 2 reads it) in addition to `task-brainstorming` — no change to test outcome, just stronger coverage.
- `tests/plugin-readme-coverage.test.ts` — README mentions every skill. `init` already mentioned; description change doesn't affect coverage.
- `tests/p-flow-cross-skill-consistency.test.ts` — branch type list + plan.md canonical sections. Not directly affected.

- [ ] **Step 3: If any test fails** — fix the underlying SKILL.md / docs issue (do NOT modify tests; they encode invariants). Re-run.

- [ ] **Step 4: Manual smoke test** — read the updated `init/SKILL.md` end-to-end and mentally trace through each state-machine cell:
  - (rules:no, specs:no) → both phases run, no folder conflicts, final message lists all four artifacts + stubs.
  - (rules:yes, specs:no) → Phase 1 skipped silently, Phase 2 runs, final message variant is correct.
  - (rules:yes, specs:yes) → refuses with correct message.
  - (rules:no, specs:yes) → refuses with correct message.
  - User skips Phase 2 at Step 6 → no stubs, final message variant correct.
  - User says "skip" at Step 7 question 6 → empty acceptance criteria, stub still written with placeholder literal.
  - Slug validation rejects a bad slug → user gets clear correction prompt.
  - `specs/<slug>/specification.md` already exists with content → refuses to overwrite that slug only, continues with others.

- [ ] **Step 5: Final commit if anything was fixed during smoke test.**

```bash
git add -A
git commit -m "fix(p-flow): post-smoke-test cleanup for init Phase 2"
```

(Skip if nothing changed.)

---

## Self-review

1. **Spec coverage** — every conversation point maps:
   - "init runs brainstorm in Phase 2" → Task 1 Step 3.
   - "не короткий — достаточный чтобы закрыть хайлевел вопросы" → Step 7's 6-question sequence, hard gate before materialisation.
   - "no `specs/repo.md`" → confirmed nowhere in the plan; explicitly called out in CLAUDE.md row (Task 3 Step 2) and release notes (Task 4 Step 2).
   - "stubs in each feature folder" → Task 1 Step 3 (Step 9 within the SKILL).
   - "later workflow handles add/modify" → Task 1 Step 4 (Step 10 final message points at `/p-flow:task-start`), release notes.
   - "drop = manual" → release notes explicitly call this out.
   - State-machine 4-cell table → Task 1 Step 2, mirrored in release notes.

2. **Placeholder scan** — no "TBD" / "later" / "appropriate handling". Each replacement chunk is full prose, ready to paste. Slug regex spelled out: `[a-z0-9-]+`. Allowed-tools listed exactly. Date format specified (`YYYY-MM-DD`). Reference to `task-brainstorming/SKILL.md:41` is line-precise.

3. **Type / name consistency** —
   - Phase numbering: Phase 1 (Steps 3–5), Phase 2 (Steps 6–9), Step 10 = final message. Step numbering monotonic across phases.
   - Slug rule: same string `[a-z0-9-]+` + length ≤ 50 in Task 1 (Step 8) — no drift.
   - `{{STATUS}}` value: literal `planned` in Task 1 (Step 9). Not asserted anywhere else, so no consistency hazard.
   - Version bump: `0.6.0 → 0.7.0` in Task 4 Step 1; release notes header says `0.7.0`; description in `plugin.json` updated to match. All three agree.
   - State-machine cells: 4 cells in Task 1 Step 2, mirrored exactly in release notes (Task 4 Step 2). Cells use identical language ("greenfield", "resume", "refuse").

---

## Open questions

- **`{{AUTHOR}}` from `git config user.name`.** Currently the plan says "fill if easily available, else leave empty". Implementing that needs `Bash(git config:*)` in allowed-tools. The current allowed-tools list in Task 1 Step 1 does NOT include it. Decide at execution time: either add `Bash(git config:*)` to allowed-tools, or accept "always leave empty". Low-stakes; default to "leave empty" if uncertain.
- **Phase 2 skip persistence.** If the user skips Phase 2, on a future re-run the state machine sees (rules:yes, specs:no) and offers Phase 2 again. That's intentional — but a user who really doesn't want it will have to dismiss it on every re-run. Not a problem unless re-runs are common. Don't add an "I really skipped on purpose" marker file unless this turns out to be annoying in practice.

## Risks

- **Mid-dialog interruption leaves a partial state.** Mitigated by Step 9's "refuse to overwrite existing stubs" + Edge cases note. Worst case: user has to manually delete a partial `specs/<slug>/` folder. Acceptable — partial brainstorms are rare and explicit cleanup beats implicit overwrite.
- **Long brainstorms exhaust user patience.** The dialog has 6 question steps + per-feature drill. For a 5-feature project that's ~11 messages. The Step 6 "Skip" affordance mitigates this. If users routinely complain about length, a future iteration could shorten Step 7's questions 3–4 into a single "tell me about users and what you won't build" combined prompt — but not in this plan.
- **`specification.template.md` placeholder names assumed.** The plan assumes the current template's placeholder names (`{{FEATURE_TITLE}}` etc.) match what Step 9 will fill. **Verify at execution time** by reading `_shared/templates/specification.template.md` before starting Task 1 Step 3 (sub-step Step 9 within the SKILL). If any placeholder name has changed, update the plan inline.
