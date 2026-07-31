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

Refresh with `/p-graph:sync`. Use the graph for candidates and for a transitive
`impact` sketch; confirm counts with grep — it costs about the same and cannot
silently miss a hit.

**Read the gap banner.** `callers` / `callees` / `impact` / `context` end with
`⚠ N call sites missing from this answer` when a call's bare name is genuinely
ambiguous — shared by two or more repo symbols, with nothing to tell them apart.
`callers`, `impact` and `context` also list a resolved call that has no caller
symbol to show (made at module scope, or inside a non-definition callback);
`callees` does not have that case. A call through an interface, a parameter, or
a local variable has no type the graph can check: when its bare name is unique
it still links, with no banner and no guarantee the receiver is the type it
names. Gaps are grouped — listed rows are worth checking, the two counted
groups are scale. Pass the banner on and grep to confirm. `status` shows the
repo-wide share as `unattributed calls N/M`. Always ask by `qname` — a bare
name merges every symbol that shares it.
