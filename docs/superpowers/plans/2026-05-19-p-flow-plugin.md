# p-flow plugin — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new plugin `p-flow` to the `perky.team` marketplace. Ships one skill (`/p-flow:init`) that scaffolds `.claude/settings.json` (with deny-permissions for secrets), `.claude/rules/p-flow.md`, and three spec templates in any target repo.

**Architecture:** Pure-content plugin — no `tools/`, no Node CLI. `/p-flow:init` is a step-by-step `SKILL.md` instructing Claude to read templates from `${CLAUDE_SKILL_DIR}/../_shared/templates/` and write them into the target repo, with a JSON-merge step for `.claude/settings.json`.

**Tech Stack:** No runtime stack. The plugin is JSON, YAML frontmatter, and Markdown. The repo's existing Vitest test suite (already in place) validates structural correctness across every plugin.

**TDD note:** No new tests are written. The existing test suite (`tests/marketplace.test.ts`, `tests/plugin-manifests.test.ts`, `tests/skills.test.ts`, `tests/templates.test.ts`) is the contract. Each task ends by running only the test files relevant to what just changed — running the full `npm test` after every step would show red intermediate states (e.g. templates added without a SKILL.md reference yet). The full suite goes green at the end of Task 3.

**Specification reference:** [`docs/superpowers/specs/2026-05-19-p-flow-plugin-design.md`](../specs/2026-05-19-p-flow-plugin-design.md).

---

## File map

| Path | Created/Modified | Responsibility |
|---|---|---|
| `plugins/p-flow/.claude-plugin/plugin.json` | Create | Plugin manifest |
| `plugins/p-flow/README.md` | Create | Describes plugin + what `/p-flow:init` creates |
| `plugins/p-flow/skills/init/SKILL.md` | Create | Init skill — 6 steps + edge cases |
| `plugins/p-flow/skills/_shared/templates/rules-p-flow.template.md` | Create | Rules file written to `.claude/rules/p-flow.md` |
| `plugins/p-flow/skills/_shared/templates/settings.template.json` | Create | `permissions.deny` block to merge into `.claude/settings.json` |
| `plugins/p-flow/skills/_shared/templates/adr.template.md` | Create | ADR template |
| `plugins/p-flow/skills/_shared/templates/feature-spec.template.feature` | Create | Gherkin feature template |
| `plugins/p-flow/skills/_shared/templates/specification.template.md` | Create | Full specification template |
| `.claude-plugin/marketplace.json` | Modify | Add `p-flow` entry |
| `README.md` | Modify | Add `p-flow` to plugins table + update layout |

---

## Task 1: Bootstrap the p-flow scaffold

**Files:**
- Create: `plugins/p-flow/.claude-plugin/plugin.json`
- Create: `plugins/p-flow/README.md`

- [ ] **Step 1: Create the plugin directories**

On Windows PowerShell:
```powershell
New-Item -ItemType Directory -Force -Path plugins\p-flow\.claude-plugin, plugins\p-flow\skills\init, plugins\p-flow\skills\_shared\templates | Out-Null
```

Or on bash:
```bash
mkdir -p plugins/p-flow/.claude-plugin plugins/p-flow/skills/init plugins/p-flow/skills/_shared/templates
```

- [ ] **Step 2: Write `plugins/p-flow/.claude-plugin/plugin.json`**

```json
{
  "name": "p-flow",
  "version": "0.1.0",
  "description": "Workflow rules for Claude: deny-permissions for secrets, Conventional Commits + <type>/<slug> branches, and spec templates (ADR, Gherkin, full specification). Skills: init.",
  "author": {
    "name": "Andrey Sukharev",
    "email": "andrey.sukharev@exinity.com"
  }
}
```

- [ ] **Step 3: Write `plugins/p-flow/README.md`**

````markdown
# p-flow

Workflow rules for Claude Code: secret-file deny-permissions, Conventional Commits + `<type>/<slug>` branch naming, and three specification templates (ADR, Gherkin feature, full specification).

## What `/p-flow:init` creates

In the current git repo (or current working directory if not a git repo):

- `.claude/settings.json` — `permissions.deny` patterns blocking reads/writes of common secret-bearing files (`.env*`, `*.pem`, `*.key`, `*credentials*`, `*secrets*`, SSH/AWS dotdirs, etc.). If the file already exists, the deny list is **merged** (union with dedup); no other keys are touched.
- `.claude/rules/p-flow.md` — workflow rules document: security guidance, Git workflow (Conventional Commits + `feature/<slug>` / `bugfix/<slug>` / `hotfix/<slug>` / `chore/<slug>` / `docs/<slug>`), specifications layout.
- `.claude/templates/p-flow/` — three template files (`adr.md`, `feature-spec.feature`, `specification.md`) that the team and any skills/agents in the repo use as the canonical structure for specs.

## Idempotency

`/p-flow:init` refuses if `.claude/rules/p-flow.md` already exists — the existing file is the marker. To reinitialise, delete that file and re-run.

## Install

```text
/plugin marketplace add perky-team/claude-plugin
/plugin install p-flow@perky.team
```

Then in any repo:

```text
/p-flow:init
```
````

- [ ] **Step 4: Validate manifest passes the existing plugin-manifests test**

Run: `npm test -- tests/plugin-manifests.test.ts`
Expected: `plugin: p-flow` block reports all assertions passing (name, version, description, README exists and >50 chars). `plugin: p-wiki` block remains green.

> Note: `npm test -- tests/skills.test.ts` and `npm test -- tests/templates.test.ts` will be **red** for `p-flow` at this point — no skill yet. That is expected and is resolved in Task 2. Do not run the full `npm test` here.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-flow/.claude-plugin/plugin.json plugins/p-flow/README.md
git commit -m "feat: scaffold p-flow plugin manifest and README"
```

---

## Task 2: Add templates and the init skill

This task adds five template files and one `SKILL.md` together. They must land in the same commit because the test suite requires every template to be referenced by at least one `SKILL.md` ("dead template" check) — a partial commit would leave the repo with red tests on `main`.

**Files:**
- Create: `plugins/p-flow/skills/_shared/templates/rules-p-flow.template.md`
- Create: `plugins/p-flow/skills/_shared/templates/settings.template.json`
- Create: `plugins/p-flow/skills/_shared/templates/adr.template.md`
- Create: `plugins/p-flow/skills/_shared/templates/feature-spec.template.feature`
- Create: `plugins/p-flow/skills/_shared/templates/specification.template.md`
- Create: `plugins/p-flow/skills/init/SKILL.md`

- [ ] **Step 1: Write `plugins/p-flow/skills/_shared/templates/settings.template.json`**

```json
{
  "permissions": {
    "deny": [
      "Read(.env*)",
      "Read(/**/.env*)",
      "Read(/**/*.pem)",
      "Read(/**/*.key)",
      "Read(/**/*.crt)",
      "Read(/**/*.p12)",
      "Read(/**/*.pfx)",
      "Read(/**/*.jks)",
      "Read(/**/*credentials*)",
      "Read(/**/*secrets*)",
      "Read(/**/service-account*.json)",
      "Read(/**/*token*.json)",
      "Read(/**/*auth*.json)",
      "Read(/**/.htpasswd)",
      "Read(/**/.netrc)",
      "Read(/**/.pgpass)",
      "Read(/**/id_rsa)",
      "Read(/**/id_ed25519)",
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Edit(.env*)",
      "Edit(/**/.env*)",
      "Edit(/**/*.pem)",
      "Edit(/**/*.key)",
      "Edit(/**/*.crt)",
      "Edit(/**/*.p12)",
      "Edit(/**/*.pfx)",
      "Edit(/**/*.jks)",
      "Edit(/**/*credentials*)",
      "Edit(/**/*secrets*)",
      "Edit(/**/.htpasswd)",
      "Edit(/**/.netrc)",
      "Edit(/**/.pgpass)",
      "Write(.env*)",
      "Write(/**/.env*)",
      "Write(/**/*.pem)",
      "Write(/**/*.key)",
      "Write(/**/*.crt)",
      "Write(/**/*credentials*)",
      "Write(/**/*secrets*)",
      "Write(/**/.htpasswd)",
      "Write(/**/.netrc)",
      "Write(/**/.pgpass)"
    ]
  }
}
```

- [ ] **Step 2: Write `plugins/p-flow/skills/_shared/templates/adr.template.md`**

```markdown
# Architecture Decision Records — `{{FEATURE_NAME}}`

> Architectural decisions for `{{FEATURE_NAME}}`.
> For project-wide decisions, see `specs/adr.md`.

---

## ADR-{{NUMBER}}: {{TITLE}}

**Date:** {{DATE}}
**Status:** {{STATUS}}
**Feature:** `{{FEATURE_NAME}}`

### Context

{{CONTEXT}}

### Alternatives Considered

{{ALTERNATIVES}}

### Decision

{{DECISION}}

### Consequences

**Positive:**
{{POSITIVE_CONSEQUENCES}}

**Negative:**
{{NEGATIVE_CONSEQUENCES}}

**Risks:**
{{RISKS}}

---
```

- [ ] **Step 3: Write `plugins/p-flow/skills/_shared/templates/feature-spec.template.feature`**

```gherkin
@{{FEATURE_NAME}} {{ADDITIONAL_TAGS}}
Feature: {{FEATURE_TITLE}}
  {{FEATURE_DESCRIPTION}}

  Background:
    {{BACKGROUND_STEPS}}

  @happy-path
  Scenario: {{SCENARIO_NAME}}
    Given {{GIVEN}}
    When {{WHEN}}
    Then {{THEN}}

  @happy-path
  Scenario Outline: {{OUTLINE_NAME}}
    Given {{GIVEN}}
    When {{WHEN}}
    Then {{THEN}}

    Examples:
      | {{COLUMN_HEADERS}} |
      | {{EXAMPLE_VALUES}} |

  @error
  Scenario: {{ERROR_SCENARIO_NAME}}
    Given {{GIVEN}}
    When {{WHEN}}
    Then {{THEN}}

  @edge-case
  Scenario: {{EDGE_CASE_SCENARIO_NAME}}
    Given {{GIVEN}}
    When {{WHEN}}
    Then {{THEN}}
```

- [ ] **Step 4: Write `plugins/p-flow/skills/_shared/templates/specification.template.md`**

```markdown
# Feature: {{FEATURE_TITLE}}

> {{ONE_LINE_DESCRIPTION}}

| Field     | Value            |
|-----------|------------------|
| Feature ID | `{{FEATURE_NAME}}` |
| Status    | {{STATUS}}       |
| Date      | {{DATE}}         |
| Author    | {{AUTHOR}}       |

---

## Overview

### Problem Statement

{{PROBLEM_STATEMENT}}

### Proposed Solution

{{PROPOSED_SOLUTION}}

### User Story

{{USER_STORY}}

---

## Actors & Roles

| Actor | Role | Interaction |
|-------|------|-------------|
{{ACTORS_TABLE}}

---

## Acceptance Criteria

{{ACCEPTANCE_CRITERIA}}

---

## Functional Requirements

### Happy Path

{{HAPPY_PATH}}

### Error Handling

{{ERROR_HANDLING}}

### Edge Cases

{{EDGE_CASES}}

### Validation Rules

{{VALIDATION_RULES}}

---

## Technical Design

### Affected Components

> *Baseline architecture is defined in `specs/repo.md`. Only deltas introduced by this feature are listed below.*

{{AFFECTED_COMPONENTS}}

### Dependencies

> *Project-wide dependencies are listed in `specs/repo.md`. Only new dependencies introduced by this feature below.*

{{NEW_DEPENDENCIES}}

---

## Non-Functional Requirements

> *Inherits project-wide NFRs from `specs/repo.md`. Feature-specific additions below.*

{{FEATURE_NFRS}}

---

## Migration & Rollout

### Strategy

{{MIGRATION_STRATEGY}}

### Feature Flags

{{FEATURE_FLAGS}}

### Backward Compatibility

{{BACKWARD_COMPATIBILITY}}

### Rollback Plan

{{ROLLBACK_PLAN}}

---

## Related Features

{{RELATED_FEATURES}}

---

## Future Considerations

{{FUTURE_CONSIDERATIONS}}
```

- [ ] **Step 5: Write `plugins/p-flow/skills/_shared/templates/rules-p-flow.template.md`**

````markdown
# p-flow rules

These rules apply to **every Claude Code session** in this repository. They were installed by `/p-flow:init` from the `p-flow` plugin.

## 1. Security

Reads and writes of common secret-bearing files (`.env*`, `*.pem`, `*.key`, `*.crt`, `*credentials*`, `*secrets*`, `~/.ssh/**`, `~/.aws/**`, etc.) are blocked by `.claude/settings.json` (`permissions.deny`).

- **Do not attempt to bypass the deny list.** If a task requires a secret, surface it to the user. Suggest passing the value via an environment variable (`process.env.X`, `$env:X`) or a secret manager (1Password CLI, `gh secret`, cloud secret managers).
- **Do not propose workarounds** like reading via shell (`Bash(cat .env)`) — the deny list covers tool calls only; reading via shell is technically possible but defeats the purpose.

## 2. Git workflow

### Commits — Conventional Commits

Format:

```
<type>(<scope>)?: <subject>

<body>

<footer>
```

- **Types:** `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `style`, `revert`.
- **`<scope>`** (optional) — a short noun describing the affected area, e.g. `auth`, `parser`, `ci`.
- **Subject:** imperative mood ("add", not "added"); ≤ 72 characters; no trailing period; first word after the prefix is lowercase.
- **Body** (optional): separated by a blank line from the subject, wrapped at 72 characters. Explain *why*, not *how*.
- **Breaking change:** put `!` immediately after the type/scope (`feat!:` or `feat(api)!:`) **and** add a `BREAKING CHANGE:` footer explaining the break.
- **Ticket references** go in the footer: `Refs: PROJ-123`.

### Branches — `<type>/<slug>`

| Prefix | Use for |
|---|---|
| `feature/` | New features |
| `bugfix/` | Non-urgent bug fixes |
| `hotfix/` | Urgent production fixes |
| `chore/` | Refactoring, dependency bumps, internal cleanups |
| `docs/` | Documentation-only changes |

- `<slug>`: kebab-case, lowercase, ≤ 50 characters, alphanumeric + hyphens only.
- Do **not** put ticket IDs in the branch name — keep them in the commit body.
- **Forbid force-push** to `main`, `master`, `develop`, and any release branch (`release/*`).

### Pull requests

- PR title follows the same Conventional Commits format as a commit.
- PR description explains *what* and *why*, not *how* — readers see the diff for *how*.

## 3. Specifications

Specs live under `specs/`. Each non-trivial feature gets its own subdirectory:

| File | When created | Template |
|---|---|---|
| `specs/<feature-slug>/specification.md` | Any non-trivial feature | `.claude/templates/p-flow/specification.md` |
| `specs/<feature-slug>/feature.feature` | Feature has behavioural scenarios | `.claude/templates/p-flow/feature-spec.feature` |
| `specs/<feature-slug>/adr.md` | Feature carries an architectural decision | `.claude/templates/p-flow/adr.md` |
| `specs/adr.md` | Project-wide architectural decision | `.claude/templates/p-flow/adr.md` |
| `specs/repo.md` | Project-wide baseline (architecture, dependencies, NFRs) | *(no template — authored once, freehand)* |

`specs/repo.md` is the document the `specification.md` template refers to in its "Affected Components / Dependencies / NFRs" sections. It's optional: if a project doesn't have one, each spec restates its full architecture and dependencies. p-flow does not create or maintain it.

### Rules for skills and agents

1. **When creating** a spec / ADR / feature file: copy the corresponding template from `.claude/templates/p-flow/` **verbatim** and fill all `{{PLACEHOLDERS}}`. Do not invent your own structure. If a section doesn't apply, write `N/A` and a one-line reason — do not delete the heading.
2. **When reading** a spec: expect this structure (headings, sections, Gherkin tags `@happy-path` / `@error` / `@edge-case`). If the file structure does not match, flag it as "not in p-flow format" and do not make false assumptions about missing or extra content.
3. **ADR numbers** are monotonic within a single file. A new file starts at `ADR-001`. Status ∈ `Proposed | Accepted | Deprecated | Superseded by ADR-XXX`.
4. **Templates** under `.claude/templates/p-flow/` are the team's source of truth. The team may adapt them per project, but only in a **backwards-compatible** way: do not delete required sections (skills and other agents depend on the headings being present).
````

- [ ] **Step 6: Write `plugins/p-flow/skills/init/SKILL.md`**

````markdown
---
name: init
description: Initialize Claude-Code workflow rules in the current repo — write `.claude/settings.json` with deny-permissions for secrets, `.claude/rules/p-flow.md` with Conventional Commits + branch naming + spec rules, and three templates under `.claude/templates/p-flow/`. Use when the user says "init p-flow", "setup p-flow", or asks to bootstrap workflow rules.
argument-hint: (no arguments)
allowed-tools: Bash(git rev-parse:*) Bash(mkdir:*) Bash(test:*) Read Write
---

# /p-flow:init

You are scaffolding the `p-flow` workflow ruleset inside the current repo.

## Step 1 — Find the repo root

Run `git rev-parse --show-toplevel` via Bash. If it fails (not a git repo), ask the user **once** whether to use the current working directory as the root. If they decline, stop. If they accept, use CWD.

Hereafter `<root>` = the resolved repo root.

## Step 2 — Refuse if already initialised

If `<root>/.claude/rules/p-flow.md` exists, stop and tell the user:

> "p-flow is already initialised at `<root>/.claude/rules/p-flow.md`. Delete that file manually if you want to reinitialise."

Do **not** check for `.claude/settings.json` as a marker — it may exist for unrelated reasons.

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

## Step 6 — Final message

Tell the user, in this order:

1. Where the rules file was written: `<root>/.claude/rules/p-flow.md`.
2. Where the templates live: `<root>/.claude/templates/p-flow/` (three files: `adr.md`, `feature-spec.feature`, `specification.md`).
3. Whether `.claude/settings.json` was created fresh or merged.
   - If created: say "Created with the full p-flow deny list."
   - If merged: list the deny patterns that were **newly added** (so the user sees the diff at a glance). If every template pattern was already present, say explicitly: "No new entries added — the existing file already covered every deny pattern from the template."
4. One-line reminder: "Conventional Commits (`<type>(<scope>)?: <subject>`) and `<type>/<slug>` branches are now the rule in this repo. Full details in `.claude/rules/p-flow.md`."

## Edge cases

- **`mkdir -p` fails** (e.g. permissions) → stop, show the exact error from the shell.
- **A template file can't be read** (`${CLAUDE_SKILL_DIR}/../_shared/templates/X` missing) → stop and tell the user the plugin install may be corrupted.
- **`.claude/settings.json` exists but is invalid JSON** → stop, ask user to fix and retry (covered in Step 5 Case B).
- **`permissions` / `permissions.deny` of wrong shape** → stop with a clear error (covered in Step 5 Case B).
````

- [ ] **Step 7: Verify templates test passes**

Run: `npm test -- tests/templates.test.ts`
Expected: for `plugin: p-flow`, every template (`rules-p-flow.template.md`, `settings.template.json`, `adr.template.md`, `feature-spec.template.feature`, `specification.template.md`) reports both "is non-empty" and "is referenced by at least one SKILL.md" passing. No `p-wiki` regressions.

If a "dead template" failure appears for any p-flow template, the `${CLAUDE_SKILL_DIR}/../_shared/templates/<file>` reference is missing or misspelled in `SKILL.md` — open `plugins/p-flow/skills/init/SKILL.md` and confirm each of the five filenames appears verbatim. Pay particular attention to `settings.template.json`, which lives in the prose of Step 5 (not in the Step 4 table).

- [ ] **Step 8: Verify skills test passes**

Run: `npm test -- tests/skills.test.ts`
Expected: for `plugin: p-flow`, the `init` skill reports passing assertions on name match, non-empty description, parseable `allowed-tools`, and body > 100 chars. No `p-wiki` regressions.

- [ ] **Step 9: Commit**

```bash
git add plugins/p-flow/skills/
git commit -m "feat: add p-flow init skill and spec templates"
```

---

## Task 3: Register in marketplace and update repo README

After this task `npm test` passes fully — the plugin is discoverable from the marketplace and the README plugins table lists it.

**Files:**
- Modify: `.claude-plugin/marketplace.json`
- Modify: `README.md`

- [ ] **Step 1: Add `p-flow` to `.claude-plugin/marketplace.json`**

Open the file. It currently looks like this:

```json
{
  "name": "perky.team",
  "description": "Claude Code plugins by perky.team.",
  "owner": {
    "name": "Andrey Sukharev",
    "email": "andrey.sukharev@exinity.com"
  },
  "plugins": [
    {
      "name": "p-wiki",
      "source": "./plugins/p-wiki",
      "description": "Persistent markdown knowledge wiki under docs/wiki/. Skills: init, ingest, compile, query, lint."
    }
  ]
}
```

Add a second entry inside `plugins`:

```json
{
  "name": "perky.team",
  "description": "Claude Code plugins by perky.team.",
  "owner": {
    "name": "Andrey Sukharev",
    "email": "andrey.sukharev@exinity.com"
  },
  "plugins": [
    {
      "name": "p-wiki",
      "source": "./plugins/p-wiki",
      "description": "Persistent markdown knowledge wiki under docs/wiki/. Skills: init, ingest, compile, query, lint."
    },
    {
      "name": "p-flow",
      "source": "./plugins/p-flow",
      "description": "Workflow rules for Claude: deny-permissions for secrets, Conventional Commits + <type>/<slug> branches, spec templates. Skills: init."
    }
  ]
}
```

- [ ] **Step 2: Update `README.md` plugins table and intro**

Make three targeted edits to `README.md`:

**(a)** Change the opening paragraph from:

```
A Claude Code plugin marketplace. Currently ships one plugin; more can land alongside it under `plugins/<name>/`.
```

to:

```
A Claude Code plugin marketplace. Plugins live under `plugins/<name>/`.
```

**(b)** Add a `p-flow` row to the plugins table. The table currently is:

```markdown
| Plugin | What it does |
|---|---|
| [`p-wiki`](./plugins/p-wiki/) | Persistent markdown knowledge wiki under `docs/wiki/`. Skills: `init`, `ingest`, `compile`, `query`, `lint`. |
```

After the edit:

```markdown
| Plugin | What it does |
|---|---|
| [`p-wiki`](./plugins/p-wiki/) | Persistent markdown knowledge wiki under `docs/wiki/`. Skills: `init`, `ingest`, `compile`, `query`, `lint`. |
| [`p-flow`](./plugins/p-flow/) | Workflow rules for Claude: secret-file deny-permissions, Conventional Commits + `<type>/<slug>` branches, spec templates. Skills: `init`. |
```

**(c)** Update the "Repository layout" tree to show both plugins. The current tree is:

```
.
├── .claude-plugin/
│   └── marketplace.json     ← catalog of plugins in this marketplace
├── plugins/
│   └── p-wiki/              ← one directory per plugin
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── README.md
│       ├── docs/superpowers/  ← per-plugin design spec + implementation plan
│       └── skills/
└── README.md                ← this file
```

Replace with:

```
.
├── .claude-plugin/
│   └── marketplace.json     ← catalog of plugins in this marketplace
├── plugins/
│   ├── p-wiki/              ← one directory per plugin
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── README.md
│   │   ├── docs/superpowers/  ← per-plugin design spec + implementation plan
│   │   └── skills/
│   └── p-flow/              ← workflow rules + spec templates
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── README.md
│       └── skills/
└── README.md                ← this file
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: every test file green. Specifically:
- `marketplace.json` block — duplicate names check passes (2 distinct plugins); both `source` paths resolve; both `plugin.json` names match.
- README plugins table check — both `p-wiki` and `p-flow` found in the first column.
- `plugin: p-flow` and `plugin: p-wiki` blocks both green across manifests / skills / templates.

If anything fails, fix the plugin to match the test — never the test to match the plugin.

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/marketplace.json README.md
git commit -m "feat: register p-flow in marketplace and document in repo README"
```

---

## Task 4: Validate via the Claude CLI

The repo has an `npm run validate` script that invokes Claude Code's own plugin validator. This catches things the static Vitest suite doesn't.

**Files:** none modified.

- [ ] **Step 1: Run validation**

Run: `npm run validate`
Expected: exits 0. Both `p-wiki` and `p-flow` print as valid.

If `p-flow` is rejected, the error message names the offending field. Common causes:
- `allowed-tools` syntax error in `SKILL.md` frontmatter — confirm spaces (not commas) between entries.
- `name` field in `plugin.json` or `SKILL.md` containing characters other than lowercase, digits, hyphens.
- A required field missing.

Fix the underlying file, re-run.

- [ ] **Step 2: No commit**

This task only verifies — nothing changed.

---

## Task 5: Smoke-test `/p-flow:init` end-to-end

Static tests don't exercise the skill's instructions. Run the skill against a fresh sandbox repo to confirm it actually does what the SKILL.md describes.

**Files:** none in this repo. Creates and destroys a temporary sandbox.

- [ ] **Step 1: Set up a sandbox repo**

Pick a temp location outside `C:\projects\perky.team\wiki`. PowerShell:

```powershell
$sandbox = Join-Path $env:TEMP "p-flow-smoke-$(Get-Date -Format yyyyMMdd-HHmmss)"
New-Item -ItemType Directory -Path $sandbox | Out-Null
cd $sandbox
git init -q
```

Bash equivalent:

```bash
sandbox="${TMPDIR:-/tmp}/p-flow-smoke-$(date +%Y%m%d-%H%M%S)"
mkdir "$sandbox" && cd "$sandbox" && git init -q
```

- [ ] **Step 2: Pre-create a `.claude/settings.json` with one pre-existing deny and one pre-existing allow**

Write `<sandbox>/.claude/settings.json` with this content:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm test:*)"
    ],
    "deny": [
      "Read(/**/.env*)"
    ]
  }
}
```

This exercises the merge path in Step 5: an existing array, a duplicate entry from the template (`Read(/**/.env*)` is in our template too — should be deduped), and an unrelated `allow` key that must survive untouched.

- [ ] **Step 3: Run `/p-flow:init`**

In a Claude Code session targeted at the sandbox directory (with the perky.team marketplace installed and `p-flow` enabled — local plugin dir is fine, see "Local development" in the repo README), invoke:

```
/p-flow:init
```

- [ ] **Step 4: Verify the rules file**

Expected: `<sandbox>/.claude/rules/p-flow.md` exists and matches `plugins/p-flow/skills/_shared/templates/rules-p-flow.template.md` byte-for-byte.

PowerShell check:
```powershell
Compare-Object (Get-Content "$sandbox\.claude\rules\p-flow.md" -Raw) (Get-Content "C:\projects\perky.team\wiki\plugins\p-flow\skills\_shared\templates\rules-p-flow.template.md" -Raw)
```
Expected: no output (files identical).

- [ ] **Step 5: Verify the templates directory**

Expected: `<sandbox>/.claude/templates/p-flow/` exists with exactly three files:
- `adr.md`
- `feature-spec.feature`
- `specification.md`

Each matches its corresponding `_shared/templates/<basename>.template.<ext>` byte-for-byte.

- [ ] **Step 6: Verify the settings.json merge**

Read `<sandbox>/.claude/settings.json`. Expected:
- `permissions.allow` is still `["Bash(npm test:*)"]` — untouched.
- `permissions.deny` contains:
  - `Read(/**/.env*)` exactly **once** (the dedup worked).
  - All ~44 other entries from the template, appended in template order **after** the pre-existing entry.
- No other top-level keys, no other `permissions` subkeys.
- 2-space indent, trailing newline.

- [ ] **Step 7: Verify the refusal path**

Run `/p-flow:init` again in the same sandbox.
Expected: refuses with message starting "p-flow is already initialised at …". No files written, no `.claude/settings.json` changes.

PowerShell sanity check after the refusal:
```powershell
(Get-Item "$sandbox\.claude\rules\p-flow.md").LastWriteTime
```
Note this timestamp before and after the second invocation — should not change.

- [ ] **Step 8: Tear down the sandbox**

```powershell
cd C:\projects\perky.team\wiki
Remove-Item -Recurse -Force $sandbox
```

- [ ] **Step 9: No commit**

The sandbox isn't tracked. Smoke test only verifies behaviour.

---

## Task 6: Release prep — version bump for the marketplace tag

Per `wiki/.claude/CLAUDE.md`, every push that changes plugin behaviour or content pairs with a semver tag at the marketplace level (`vX.Y.Z`). Adding a new plugin is a **minor** bump.

**Files:** none in this task. Tag is created at push time.

- [ ] **Step 1: Confirm `plugin.json` versions are correct**

```bash
git diff main -- plugins/p-wiki/.claude-plugin/plugin.json
```
Expected: no diff (p-wiki version stays at `3.0.0`).

```bash
cat plugins/p-flow/.claude-plugin/plugin.json
```
Expected: includes `"version": "0.1.0"`.

- [ ] **Step 2: Identify the next marketplace tag**

```bash
git tag --list 'v*' --sort=-v:refname | head -1
```
Expected: `v3.0.0`. The next minor bump (additive change — new plugin, nothing removed) is **`v3.1.0`**.

- [ ] **Step 3: Surface the proposed version to the user**

Per repo rule: never tag silently. State to the user:

> "Proposed release tag: **v3.1.0** (minor — adds plugin `p-flow`, nothing removed in `p-wiki`). Confirm to proceed."

Wait for explicit confirmation. Do not run `git tag` or `git push --tags` without it.

- [ ] **Step 4: After confirmation — tag and push**

```bash
git push
git tag v3.1.0
git push --tags
```

The first `git push` carries the three commits from Tasks 1–3. The tag goes after — paired with the push, as the repo rule prescribes.

---

## Self-review checklist (for the engineer)

Before declaring done:

- `npm test` exits 0 on a clean working tree (verified at end of Task 3).
- `npm run validate` exits 0 (verified at end of Task 4).
- Smoke test in Task 5 passed all seven sub-steps.
- Three commits land cleanly on `main`:
  1. `feat: scaffold p-flow plugin manifest and README`
  2. `feat: add p-flow init skill and spec templates`
  3. `feat: register p-flow in marketplace and document in repo README`
- `v3.1.0` tag is created and pushed (Task 6) only after explicit user confirmation.
- `git status` shows no untracked artefacts.
