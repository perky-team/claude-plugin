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

## 4. Skills and flow

This plugin provides a task development flow. From any non-trivial idea to a pushed branch with an MR recommendation, the sequence is:

| Phase | Skill / command | Output |
|---|---|---|
| Entry | `/p-flow:task-start <slug>` | Branch `<type>/<slug>` created (+ optional worktree), `specs/<slug>/` opened, brainstorming invoked. |
| Design | `task-brainstorming` skill | `specs/<slug>/specification.md` (always), optionally `feature.feature`, optionally `adr.md`. |
| Plan | `writing-plan` skill | `specs/<slug>/plan.md`. |
| Execute | `executing-plan` skill | Walks `plan.md` `## Steps` in order — TDD per code step, verify after each, check off `- [x]` on green; a red step routes to `systematic-debugging`. |
| Verify | `verification-before-completion` skill | Concrete test/lint output is quoted before any "done" claim. Writes `.claude/.p-flow-state/<branch-safe>/last-verification` (`<branch-safe>` = branch name with `/` → `__`). |
| Review (code) | `requesting-code-review` skill + `code-reviewer` agent | Code-quality findings, triaged into `plan.md` follow-ups. |
| Review (spec) | `requesting-task-review` skill + `task-reviewer` agent | Spec-alignment findings, triaged into `plan.md` follow-ups. |
| Exit | `/p-flow:task-end` | `git push -u origin <branch>` + MR title/body recommendation with both `gh` and `glab` commands ready to copy. |

### Note on §3 "N/A" rule

The rule in §3.1 — "if a section doesn't apply, write `N/A` and a one-line reason — do not delete the heading" — applies to **feature** specs. For bugfix / hotfix / chore / tech-task specs, sections that don't apply may be **omitted entirely**. Skills produce specs that drop irrelevant sections rather than filling them with `N/A`.

### State directory

`task-end` reads a marker at `.claude/.p-flow-state/<branch-safe>/last-verification` (where `<branch-safe>` is the branch name with `/` replaced by `__`) to detect whether verification ran. This directory is added to `.gitignore` on first write by `verification-before-completion`.
