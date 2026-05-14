---
name: lint
description: |
  Audit the wiki for problems: dead links, orphan pages, frontmatter errors, underlinked concept pages, stale entries. Reports only — never fixes automatically. Use when the user says "lint wiki", "check the wiki", "audit wiki", or asks whether the wiki has issues.
argument-hint: (no arguments)
allowed-tools: Bash(git rev-parse:*) Bash(node:*)
---

# /p-wiki:lint

You are auditing the wiki and producing a report. You do NOT modify any wiki files.

## Step 1 — Find the wiki

`<root>` = `git rev-parse --show-toplevel`. Confirm `<root>/docs/wiki/CLAUDE.md` exists.

## Step 2 — Run lint via CLI

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pwiki.mjs" lint
```

The CLI emits the report directly to stdout (errors first, warnings after, totals at the bottom). Pass its output through to the user verbatim. Exit code is always 0 — the CLI never fails on findings.

## Step 3 — Append next-step hint

After the CLI output, append one line:

> Run `/p-wiki:compile` after fixes, then re-lint.

Do not propose fixes inline — let the user decide.

## Edge cases

All handled inside the CLI:
- Broken YAML → recorded as a frontmatter error; other checks for that file are skipped.
- Symlinks → resolved as their target.
- Stale moved-source paths → still reported as dead-sources.
