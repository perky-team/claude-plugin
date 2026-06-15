---
name: help
description: Show the pgraph command cheat-sheet and when to use each. Use when the user says "p-graph help" or asks what pgraph can do.
allowed-tools: Read
---

# p-graph: help

Present this cheat-sheet:

- `search <q>` — find a symbol by name/qname.
- `node <id|qname>` — one symbol's kind, location, signature.
- `callers <name>` / `callees <name>` — who calls it / what it calls.
- `impact <name>` — transitive callers (what breaks if it changes).
- `trace <from> <to>` — a call path between two symbols.
- `context <q>` — a symbol plus its immediate callers/callees.
- `explore <names…>` — several symbols at once.
- `files <path>` — files under a path with symbol counts.
- `index [--full|--changed]` / `status` — build / inspect the graph.

Refresh with `/p-graph:sync`. Prefer these over grep for structural questions.
