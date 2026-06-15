---
name: init
description: Initialize p-graph in the current repo — create .pgraph/, gitignore it, install the CLAUDE.md rule, and run the first full index. Use when the user says "init p-graph", "set up code graph", or "index this repo".
allowed-tools: Bash(node:*) Bash(git:*) Read Edit Write
---

# p-graph: init

1. Find the repo root (the dir containing `.git`).
2. Create `.pgraph/` and write `.pgraph/config.json` with `{ "destination": "local" }`.
3. Ensure `.gitignore` contains a line `.pgraph/` (append if missing).
4. Install the rule: read `${CLAUDE_SKILL_DIR}/../_shared/templates/p-graph-rule.template.md`
   and write it to `.claude/rules/p-graph.md` (create `.claude/rules/` if needed). If a
   project `CLAUDE.md` exists, also merge the `${CLAUDE_SKILL_DIR}/../_shared/templates/pgraph-claude-md.template.md`
   snippet under a "## Tooling" section if not already present.
5. Run the first full index:
   `node ${CLAUDE_PLUGIN_ROOT}/tools/pgraph.mjs index --full`
6. Print `node ${CLAUDE_PLUGIN_ROOT}/tools/pgraph.mjs status` so the user sees node/edge/file counts.

Report what was created and the index counts. Note that Node ≥ 22.5 is required.
