---
name: sync
description: Refresh the p-graph code graph after code changes (incremental by default). Use when the user says "sync p-graph", "reindex", "update the code graph", or after pulling/branch-switching.
allowed-tools: Bash(node:*)
---

# p-graph: sync

1. Run incremental sync: `node ${CLAUDE_PLUGIN_ROOT}/tools/pgraph.mjs index --changed`.
   - This diffs `git diff <indexed_sha>..HEAD` plus the dirty working tree and reparses
     only the changed files. If the repo isn't a git checkout, it falls back to a full index.
2. For an explicit full rebuild (after large refactors, or if `status` looks wrong), run
   `node ${CLAUDE_PLUGIN_ROOT}/tools/pgraph.mjs index --full`.
3. Print `node ${CLAUDE_PLUGIN_ROOT}/tools/pgraph.mjs status` and report counts + drift.

If `.pgraph/` does not exist yet, tell the user to run `/p-graph:init` first.
