---
name: help
description: Show the pobserve command cheat-sheet and what p-observe can see. Use when the user says "p-observe help" or asks what pobserve can do.
---

# /p-observe:help

Run the CLI's own help and relay it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pobserve.mjs" help
```

p-observe is a **zero-touch** observer. It watches, but never modifies, the runtime state of
p-shed, p-tasks, p-graph, and p-wiki in the current repo, and prints a normalized event stream.

- `pobserve watch` — live merged stream (`--plugin=`, `--severity=`, `--journal`).
- `pobserve status` — one-shot snapshot (counters + running/failed).
- `pobserve capture` — headless; keep it running to persist the full offline timeline to `.pobserve/events.jsonl`.

Blind zones (by design): a Jira-primary p-tasks and a Confluence-primary p-wiki have no local
files to watch; p-graph shows aggregate counts (needs `pgraphCli` configured), not per-symbol changes.
