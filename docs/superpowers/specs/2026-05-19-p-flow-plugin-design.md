# p-flow plugin — design

**Date:** 2026-05-19
**Scope:** add a new plugin `p-flow` to the `perky.team` marketplace. The plugin ships one skill, `/p-flow:init`, which scaffolds a Claude-Code workflow setup in any target repo: a deny-permissions block in `.claude/settings.json`, a workflow rules file at `.claude/rules/p-flow.md`, and three specification templates under `.claude/templates/p-flow/`.

## Goals

1. Codify a single workflow (Conventional Commits + `<type>/<slug>` branches, spec templates for ADR / Gherkin feature / full specification) so every Claude-Code session in a given repo sees the same rules.
2. Block reads/writes of common secret-bearing files via `.claude/settings.json` so Claude never accidentally exfiltrates credentials.
3. Provide a single source of truth for specification structure so any skill or agent in the project — whether generating or consuming specs — uses the same shape.
4. Stay consistent in style with the existing `p-wiki` plugin: same directory layout, same `_shared/templates/` convention, same "refuse if already initialised" semantics.

## Non-goals

- No CLI helper (`tools/`) — the skill is pure file-copy + JSON merge, no Node runtime needed.
- No upgrade flow / no versioned manifest in the target repo. If the plugin evolves and a user wants the latest rules/templates, they delete `.claude/rules/p-flow.md` and re-run `/p-flow:init`.
- No `/p-flow:spec`, `/p-flow:adr`, `/p-flow:check` skills in v1. Templates live in the target repo; whichever skill/agent creates a spec is expected to read the template from there.
- No hooks, no `permissions.allow`, no env. The plugin only adds `permissions.deny`.
- No mirror destinations (no Confluence/etc.) — out of scope for a workflow plugin.

## Plugin layout

```
plugins/p-flow/
├── .claude-plugin/
│   └── plugin.json
├── README.md
└── skills/
    ├── init/
    │   └── SKILL.md
    └── _shared/
        └── templates/
            ├── rules-p-flow.template.md
            ├── settings.template.json
            ├── adr.template.md
            ├── feature-spec.template.feature
            └── specification.template.md
```

No `tools/`, no `docs/` — both intentionally omitted. `_shared/templates/` mirrors the `p-wiki` convention even though only one skill consumes it today; this leaves room for future `/p-flow:spec` and `/p-flow:adr` skills without moving files.

### plugin.json

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

### marketplace.json entry (added)

```json
{
  "name": "p-flow",
  "source": "./plugins/p-flow",
  "description": "Workflow rules for Claude: deny-permissions for secrets, Conventional Commits + <type>/<slug> branches, spec templates. Skills: init."
}
```

## `/p-flow:init` skill

`SKILL.md` frontmatter:

```yaml
name: init
description: |
  Initialize Claude-Code workflow rules in the current repo: write `.claude/settings.json` with deny-permissions for secrets, `.claude/rules/p-flow.md` with Conventional Commits + branch naming + spec rules, and three templates under `.claude/templates/p-flow/`. Use when the user says "init p-flow", "setup p-flow", or asks to bootstrap workflow rules.
argument-hint: (no arguments)
allowed-tools: Bash(git rev-parse:*) Bash(mkdir:*) Bash(test:*) Read Write
```

### Steps

**Step 1 — Find the repo root.** Run `git rev-parse --show-toplevel`. If it fails (not a git repo), ask the user once whether to use the current working directory as the root. If they decline, stop. If they accept, use CWD. Hereafter `<root>` = the resolved repo root.

**Step 2 — Refuse if already initialised.** If `<root>/.claude/rules/p-flow.md` exists, stop and tell the user: "p-flow is already initialised at `<root>/.claude/rules/p-flow.md`. Delete that file manually if you want to reinitialise." `settings.json` is not a marker — it may exist for other reasons.

**Step 3 — Create directories.** `mkdir -p` for:

```
<root>/.claude/
<root>/.claude/rules/
<root>/.claude/templates/p-flow/
```

**Step 4 — Copy templates verbatim.**

| Read from (`${CLAUDE_SKILL_DIR}/../_shared/templates/…`) | Write to (`<root>/…`) |
|---|---|
| `rules-p-flow.template.md` | `.claude/rules/p-flow.md` |
| `adr.template.md` | `.claude/templates/p-flow/adr.md` |
| `feature-spec.template.feature` | `.claude/templates/p-flow/feature-spec.feature` |
| `specification.template.md` | `.claude/templates/p-flow/specification.md` |

No transformations — Read, then Write byte-for-byte. `{{PLACEHOLDERS}}` stay literal.

> `settings.template.json` is **not** in this table — it's the only file that doesn't get written verbatim. It's handled in Step 5 (merge). But the SKILL.md body **must** still reference its bundle path as `${CLAUDE_SKILL_DIR}/../_shared/templates/settings.template.json` inside Step 5's prose, so the `templates.test.ts` "dead template" check passes.

**Step 5 — Merge `.claude/settings.json`.** Read `settings.template.json` from the bundle. Then branch on the target file:

- **File missing** → Write template verbatim.
- **File exists** → Read it as JSON. If parse fails, stop and ask the user to fix invalid JSON manually, then re-run. Otherwise merge:
  - Ensure `permissions` object exists.
  - Ensure `permissions.deny` array exists.
  - For each entry from the template's `permissions.deny`, append to `permissions.deny` if not already present (case-sensitive exact match). Preserve original ordering: existing entries first, new entries appended in template order.
  - **Do not touch** any other key (`permissions.allow`, `permissions.ask`, `hooks`, `env`, etc.).
  - Write the merged object back, indented with 2 spaces, trailing newline.

**Step 6 — Final message.** Tell the user, in order:

1. Where the rules file was created (`<root>/.claude/rules/p-flow.md`).
2. Where templates live (`<root>/.claude/templates/p-flow/`).
3. Whether `.claude/settings.json` was created fresh or merged. If merged: list the deny patterns that were newly added, or — if the existing file already had every pattern — explicitly say "no new entries added (existing file already covered every deny pattern from the template)".
4. Reminder: Conventional Commits + `<type>/<slug>` branches are now the rule.

### Edge cases

- `mkdir -p` fails (permissions) → stop, show the exact error.
- A template file can't be read (plugin bundle corrupted) → stop, say the plugin install may be corrupted.
- `.claude/settings.json` exists but is invalid JSON → stop, ask user to fix and retry.
- `.claude/settings.json` has `permissions` or `permissions.deny` of the wrong shape (e.g. `permissions` is not an object, or `permissions.deny` is not an array) → stop with a clear error: "Cannot merge: `permissions.deny` is not an array. Fix `.claude/settings.json` manually and retry."

## Templates

### `rules-p-flow.template.md`

A single Markdown file (~150 lines) with three sections.

**Section 1 — Security.** Cross-reference to `.claude/settings.json`. Explicit instruction: do not attempt to bypass the deny list. If the user needs a secret, propose ENV-based access or a secret manager.

**Section 2 — Git workflow.**

- **Commits — Conventional Commits.** Format: `<type>(<scope>)?: <subject>`. Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `style`, `revert`. Subject: imperative, ≤ 72 chars, no trailing period. Body separated by blank line, wrap at 72. Breaking change: `!` after type/scope **and** `BREAKING CHANGE:` footer.
- **Branches — `<type>/<slug>`.** Types: `feature`, `bugfix`, `hotfix`, `chore`, `docs`. `<slug>` is kebab-case, lowercase, ≤ 50 chars, no ticket IDs (put the ticket in commit body via `Refs:`). Forbid force-push to `main`, `master`, `develop`, release branches.
- **PR.** Title follows the same Conventional Commits format as a commit. Description explains what and why, not how.

**Section 3 — Specifications.**

Defines `specs/<feature-slug>/` as the canonical location for specification artifacts:

| File | When created | Template |
|---|---|---|
| `specs/<feature-slug>/specification.md` | Any non-trivial feature | `.claude/templates/p-flow/specification.md` |
| `specs/<feature-slug>/feature.feature` | Feature has behavioral scenarios | `.claude/templates/p-flow/feature-spec.feature` |
| `specs/<feature-slug>/adr.md` | Feature carries an architectural decision | `.claude/templates/p-flow/adr.md` |
| `specs/adr.md` | Project-wide architectural decision | `.claude/templates/p-flow/adr.md` |
| `specs/repo.md` | Project-wide baseline (architecture, dependencies, NFRs) | *(no template — authored once, freehand)* |

`specs/repo.md` is the document the `specification.md` template refers to in its "Affected Components / Dependencies / NFRs" sections. It's optional: if a project doesn't have one, each spec restates its full architecture and dependencies. p-flow does not create or maintain it.

Explicit rules for skills and agents:

1. **When creating** a spec/ADR/feature file: copy the corresponding template from `.claude/templates/p-flow/` verbatim and fill all `{{PLACEHOLDERS}}`. Do not invent your own structure.
2. **When reading** a spec: expect this structure (headings, sections, Gherkin tags `@happy-path` / `@error` / `@edge-case`). If structure differs, flag the file as "not in p-flow format" and avoid false assumptions about its contents.
3. ADR numbers are monotonic within a single file. New file starts at `ADR-001`. Status ∈ `Proposed | Accepted | Deprecated | Superseded by ADR-XXX`.
4. Templates under `.claude/templates/p-flow/` are the team's source of truth. The team may adapt them per project, but only in a backwards-compatible way (don't delete required sections — skills depend on them).

### `settings.template.json`

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

Exactly the set the user provided. No additions, no removals.

### `adr.template.md`

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

### `feature-spec.template.feature`

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

### `specification.template.md`

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

## README.md (plugin)

≤ 80 lines. Sections: what it does, what `/p-flow:init` creates in a target repo, how to install/enable via the `perky.team` marketplace, what `permissions.deny` blocks and why.

## Tests

The repo has a Vitest-based static test suite (`tests/`) that walks every plugin via `findPlugins()`. Confirmed plugin-agnostic: no `p-wiki` hardcodes. Adding `p-flow` means it must pass the same gates:

- `plugin-manifests.test.ts` — `p-flow` has a valid `plugin.json` (name matches directory, semver version, description present).
- `marketplace.test.ts` — `p-flow` entry in `marketplace.json` points to a real path.
- `skills.test.ts` — `skills/init/SKILL.md` has valid frontmatter (`name: init`, `description` present, `allowed-tools` parses).
- `templates.test.ts` — every file under `skills/_shared/templates/` (a) is non-empty and (b) is referenced by **at least one SKILL.md** via the literal pattern `${CLAUDE_SKILL_DIR}/../_shared/templates/<filename>`. Dead templates fail. Implementation note: SKILL.md must reference `settings.template.json` in this exact form inside Step 5's prose to satisfy the check.

If any existing assertion would fail, fix the plugin to match the test, not the test to match the plugin.

## Release

Per repo rule (`wiki/.claude/CLAUDE.md`): adding a new plugin is a **minor** bump.

Existing tags in the repo are flat (`v0.1.0` … `v3.0.0`) and track the marketplace as a whole. Continuing that scheme:

- `plugins/p-wiki/.claude-plugin/plugin.json#version` stays at `3.0.0` (unchanged).
- `plugins/p-flow/.claude-plugin/plugin.json#version` ships at `0.1.0` (new plugin's own first version).
- Repo tag for the release: `v3.1.0` (minor bump from `v3.0.0` because the change is additive — a new plugin, nothing removed).
- Bump the plugin's version field whenever its `p-flow` content changes; bump the repo tag whenever any plugin changes, by the same patch/minor/major rules.

## Open questions

None — all decisions are pinned in the sections above.
