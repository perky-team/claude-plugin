---
name: writing-skills
description: Use when creating a new p-flow skill or substantially editing an existing one — establishes the conventions (frontmatter shape, section order, dispatch patterns, template placement, test coverage) so the plugin stays internally consistent.
allowed-tools: Read Write Edit Glob
---

# writing-skills

A skill in p-flow is a Markdown file at `skills/<name>/SKILL.md` with YAML frontmatter + body. This skill documents what makes a good p-flow skill.

## When to use

- Creating a new skill (new directory under `plugins/p-flow/skills/`).
- Substantially editing an existing SKILL.md (more than typo-level changes).
- Reviewing a PR that adds or edits a skill.

**Don't use when:**

- Making typo / wording fixes — those don't need a convention check.
- Adding a hook, agent template, or repo-level doc — those follow different conventions (see `plugins/p-flow/CLAUDE.md`).

## Frontmatter conventions

Every p-flow SKILL.md MUST have:

```yaml
---
name: <dir-name>                    # MUST match the directory name
description: <one-line, ≥ 30 chars> # "Use when ..." or "Use after ..." — what triggers the skill
allowed-tools: <space-separated>    # Tightest allowlist that covers the body's actual usage
---
```

May have:

- `argument-hint: <pattern>` — if the skill is a user-facing slash command (`/p-flow:<name>`).

Do NOT use:

- `tools:` — that's the agents/ field; p-flow uses inline templates, not registered agents (see Wave A migration in `docs/plans/2026-05-27-superpowers-parity-remediation.md`).
- `model:` — skills don't pick models; the calling subagent does.
- `color:` — UI affordance for registered agents only.

**Gotcha:** YAML parses bare strings with `: ` as key/value pairs. Avoid colons followed by space in `description:` — use em-dash (`—`) instead. The skills.test.ts will catch this.

## Body section conventions

p-flow's voice is **procedural**, not pedagogical. Sections in this order:

1. `# <name>` — one-sentence what-this-does
2. `**Announce at start:**` — one-line announcement template
3. `## When to use` — triggers, plus "Don't use when" exclusions
4. `## Inputs` (if any) — what the skill expects in context
5. `## Procedure` — numbered steps
6. `## Hard rules` — non-negotiables
7. `## Red flags — STOP` — rationalizations to refuse
8. `## What this skill does NOT do` — out-of-scope clarification

Optional sections — `## Output format` (for skills that emit structured artifacts), `## Design note` (when a deliberate divergence needs defending against drift).

## Dispatch patterns

- **Skill invokes another skill** → use the `Skill` tool. Example — `task-start` invokes `task-brainstorming` via Skill.
- **Skill dispatches a reviewer** → use the `Task` tool with `subagent_type: general-purpose` + inline a template file colocated with the SKILL.md (`${CLAUDE_SKILL_DIR}/<reviewer>.md`). Do NOT use registered subagents — p-flow migrated away from that pattern in Wave A.

## Templates

- **User-repo templates** (init copies into `.claude/templates/p-flow/`) → live in `_shared/templates/` with `*.template.<ext>` naming. The init skill must reference them by path.
- **Skill-internal templates** (read at runtime, never copied to user repo) → live in `_shared/templates/` too; the consuming skill references via `${CLAUDE_SKILL_DIR}/../_shared/templates/<file>`. Plan template variants in Wave C are an example.
- Every template in `_shared/templates/` MUST be referenced by at least one SKILL.md — the dead-template test (`tests/templates.test.ts`) enforces this.

## Test coverage

Adding a new skill auto-triggers structural assertions:

- `tests/skills.test.ts` — frontmatter + body shape (name matches dir, description ≥ 30 chars, body > 100 chars, allowed-tools parseable).
- `tests/plugin-readme-coverage.test.ts` — the new skill must be mentioned in `plugins/p-flow/README.md` (backtick or slash-command form).

If the skill adds a new cross-skill invariant (e.g. references a canonical section name, dispatches a specific subagent, writes to a specific path), add an explicit assertion in `tests/p-flow-cross-skill-consistency.test.ts` or a new dedicated test file.

## Hard rules

- **One skill, one purpose.** If you find yourself writing two distinct procedures, split into two skills.
- **No code in skill bodies.** Skills are prompts, not implementations. Code goes in `tools/` (we don't ship any p-flow tools yet; the first one would be a new pattern).
- **Procedural voice, not pedagogical.** No "Iron Law / Common Rationalizations / Real Examples" sections; use concrete `## Hard rules` and `## Red flags — STOP` with forbidden phrases instead.
- **No XML emphasis tags** (`<EXTREMELY-IMPORTANT>`, `<SUBAGENT-STOP>`) except in `using-p-flow` (the discovery skill loaded by the SessionStart hook).

## Red flags — STOP

- "This is a one-off; doesn't need to follow conventions." If it lives in `skills/`, it follows the conventions. Otherwise put it in `docs/` as a reference doc.
- "I'll add tests later." No — adding a skill ships test infrastructure with it (auto-coverage from skills.test.ts + plugin-readme-coverage). Adding cross-skill invariants without an explicit test is drift waiting to happen.
- "The frontmatter description doesn't fit on one line." Then the skill is doing too much; split it.
- "I'll skip the announce-at-start line because it feels redundant." No — the convention exists across all skills; breaking it for one creates inconsistency for readers.

## What this skill does NOT do

- Does not generate skills automatically — you write the SKILL.md by hand.
- Does not validate the skill's behavioural effectiveness — that's manual smoke testing (see `plugins/p-flow/docs/specs/2026-05-27-superpowers-parity.md` "Tier 3 — not testable automatically").
- Does not enforce style on existing skills retroactively — only applies when you're authoring or editing.
- Does not cover agents/ (that pattern was removed in Wave A) or hooks (see `plugins/p-flow/CLAUDE.md` for hook conventions).
