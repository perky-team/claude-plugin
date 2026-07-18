---
name: init
description: Initialize p-observe in the current repo — detect which observed plugins are present, resolve the p-graph CLI path for counts, and write an optional .pobserve.json. Use when the user says "init p-observe" or "set up plugin observability".
---

# /p-observe:init

You are setting up p-observe in the current git repo.

## Step 1 — Find the repo root
`<root>` = `git rev-parse --show-toplevel`.

## Step 2 — Detect observed plugins
Report which of these exist under `<root>`: `.pshed/`, `docs/tasks/tasks.yml`, `.pgraph/graph.db`, `docs/wiki/`.
For `docs/wiki/.pwiki.json`, if `primary` is `confluence` with no fs mirror, tell the user the wiki adapter will be skipped (no local files to watch).

## Step 3 — Resolve the p-graph CLI (optional, enables node/edge counts)
There is **no automatic path** to another plugin's install dir. Probe the known install locations:

```bash
ls ~/.claude/plugins/cache/*/p-graph/tools/pgraph.mjs \
   ~/.claude/plugins/marketplaces/*/plugins/p-graph/tools/pgraph.mjs 2>/dev/null
```

- Exactly one match → propose it as `pgraphCli` and ask the user to confirm.
- Zero or multiple → ask the user to paste the path (or skip; the graph adapter then shows coarse "db changed" events without counts).

## Step 4 — Write `.pobserve.json` (only if the user overrides a default)
Write only the keys that differ from defaults, e.g.:

```json
{ "pgraphCli": "/home/you/.claude/plugins/cache/perky-team/p-graph/tools/pgraph.mjs" }
```

## Step 5 — Confirm `.pobserve/` is gitignored
Ensure `<root>/.gitignore` contains `.pobserve/`. If not, add it.

## Step 6 — Offer next step
Suggest `/p-observe:watch` (live) or a background `pobserve capture` for full offline capture.
