---
name: init
description: Initialize Claude-Code workflow rules in the current repo — write `.claude/settings.json` with deny-permissions for secrets, `.claude/rules/p-flow.md` with Conventional Commits + branch naming + spec rules, and three templates under `.claude/templates/p-flow/`. Use when the user says "init p-flow", "setup p-flow", or asks to bootstrap workflow rules.
argument-hint: (no arguments)
allowed-tools: Bash(git rev-parse:*) Bash(mkdir:*) Bash(test:*) Read Write
---

# /p-flow:init

You are scaffolding the `p-flow` workflow ruleset inside the current repo.

**Announce at start:** *"I'm using the `init` skill to scaffold p-flow rules + templates + secret-deny-list into this repo."*

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
