---
name: init
description: Initialize Claude-Code workflow rules in the current repo AND brainstorm the initial high-level feature breakdown. Phase 1 — scaffold `.claude/settings.json` (secret deny-list), `.claude/rules/p-flow.md`, and four templates under `.claude/templates/p-flow/`. Phase 2 — dialog with the user to identify vision + features, then create `specs/<slug>/specification.md` stubs for each. Use when the user says "init p-flow", "setup p-flow", or asks to bootstrap a new repo.
argument-hint: (no arguments)
allowed-tools: Bash(git rev-parse:*) Bash(mkdir:*) Bash(test:*) Bash(ls:*) Read Write
---

# /p-flow:init

You are scaffolding the `p-flow` workflow ruleset inside the current repo.

**Announce at start:** *"I'm using the `init` skill to scaffold p-flow rules + templates + secret-deny-list into this repo."*

## Step 1 — Find the repo root

Run `git rev-parse --show-toplevel` via Bash. If it fails (not a git repo), ask the user **once** whether to use the current working directory as the root. If they decline, stop. If they accept, use CWD.

Hereafter `<root>` = the resolved repo root.

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

## Phase 1 — Scaffolding

## Step 3 — Create directories

Use `mkdir -p` via Bash for:

```
<root>/.claude/
<root>/.claude/rules/
<root>/.claude/templates/p-flow/
```

## Step 4 — Copy templates verbatim

Read each template from this skill's bundle and write it into the repo, byte-for-byte. `{{PLACEHOLDERS}}` stay literal.

| Read from | Write to |
|---|---|
| `${CLAUDE_SKILL_DIR}/../_shared/templates/rules-p-flow.template.md` | `<root>/.claude/rules/p-flow.md` |
| `${CLAUDE_SKILL_DIR}/../_shared/templates/adr.template.md` | `<root>/.claude/templates/p-flow/adr.md` |
| `${CLAUDE_SKILL_DIR}/../_shared/templates/feature-spec.template.feature` | `<root>/.claude/templates/p-flow/feature-spec.feature` |
| `${CLAUDE_SKILL_DIR}/../_shared/templates/specification.template.md` | `<root>/.claude/templates/p-flow/specification.md` |

`settings.template.json` is **not** in this table — see Step 5.

## Step 5 — Merge `.claude/settings.json`

Read the template `${CLAUDE_SKILL_DIR}/../_shared/templates/settings.template.json`. Then branch on the target file `<root>/.claude/settings.json`:

### Case A — file missing

Write `settings.template.json` to `<root>/.claude/settings.json` verbatim.

### Case B — file exists

1. Read it as JSON. If `JSON.parse` fails, **stop** and tell the user: "Cannot proceed: `<root>/.claude/settings.json` is not valid JSON. Fix it manually and re-run `/p-flow:init`."
2. Validate shape:
   - If `permissions` exists and is **not** an object → stop with: "Cannot merge: `permissions` in `.claude/settings.json` is not an object. Fix it manually and re-run."
   - If `permissions.deny` exists and is **not** an array → stop with: "Cannot merge: `permissions.deny` in `.claude/settings.json` is not an array. Fix it manually and re-run."
3. Otherwise, merge:
   - Ensure `permissions` is an object (create `{}` if missing).
   - Ensure `permissions.deny` is an array (create `[]` if missing).
   - For each entry from the template's `permissions.deny`, append to the target `permissions.deny` **only if not already present** (case-sensitive exact string match). Preserve ordering: existing entries first, then any new entries in template order.
   - **Do not touch** any other key — `permissions.allow`, `permissions.ask`, `hooks`, `env`, plugin-specific keys all stay as-is.
4. Write the merged object back to `<root>/.claude/settings.json`. Format: indent with 2 spaces, trailing newline.

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

## Edge cases

- **`mkdir -p` fails** (e.g. permissions) → stop, show the exact error from the shell.
- **A template file can't be read** (`${CLAUDE_SKILL_DIR}/../_shared/templates/X` missing) → stop and tell the user the plugin install may be corrupted.
- **`.claude/settings.json` exists but is invalid JSON** → stop, ask user to fix and retry (covered in Step 5 Case B).
- **`permissions` / `permissions.deny` of wrong shape** → stop with a clear error (covered in Step 5 Case B).
- **User interrupts mid-dialog in Phase 2** → no rollback. Folders created so far stay. On re-run, the state machine (Step 2) will detect "rules:yes, specs:yes" if any stub was written and refuse — the user has to delete the partial `specs/<slug>/` folders manually to resume. This is acceptable: a partial brainstorm is rare, and explicit cleanup beats implicit overwrite.
- **`git config user.name` not set** → leave `{{AUTHOR}}` empty in stubs; don't prompt.
- **Phase 2 dialog produces 0 features** (user said skip on the decomposition question) → write no stubs, jump to Step 10 with the "Phase 2 was skipped" message variant.
