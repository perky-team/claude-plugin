---
name: sync
description: Explicitly rebuild the p-graph code graph — full or incremental. Day-to-day freshness is automatic (queries auto-refresh); use this for a full rebuild after a big refactor, or to warm the graph after a pull. Use when the user says "sync p-graph", "reindex", "rebuild the code graph", or "full reindex".
allowed-tools: Bash(node:*)
---

# p-graph: sync

> Structural queries now auto-refresh the graph before answering, so you rarely
> need this. Use `/p-graph:sync` for an explicit full rebuild after a large
> refactor, or to warm the graph after a pull/branch-switch.

1. Run incremental sync: `node ${CLAUDE_PLUGIN_ROOT}/tools/pgraph.mjs index --changed`.
   - This diffs `git diff <indexed_sha>..HEAD` plus the dirty working tree and reparses
     only the changed files. If the repo isn't a git checkout, it falls back to a full index.
2. For an explicit full rebuild (after large refactors, or if `status` looks wrong), run
   `node ${CLAUDE_PLUGIN_ROOT}/tools/pgraph.mjs index --full`.
3. Print `node ${CLAUDE_PLUGIN_ROOT}/tools/pgraph.mjs status` and report counts + drift.

If `.pgraph/` does not exist yet, tell the user to run `/p-graph:init` first.
