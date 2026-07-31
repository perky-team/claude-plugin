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

**Read the gap banner.** `callers` / `callees` / `impact` / `context` end with
`⚠ N unattributed call sites` when the graph could not tell which symbol a call
targets (interface, parameter or local receiver; ambiguous bare name). Those call
sites are missing from the answer above it, so pass the banner on and grep to
confirm. `status` shows the repo-wide share as `unattributed calls N/M`. Always
ask by `qname` — a bare name merges every symbol that shares it.
