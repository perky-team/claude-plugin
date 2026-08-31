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
- `impact <name>` — transitive callers (what breaks if it changes), along certain edges only.
- `trace <from> <to>` — a call path between two symbols.
- `context <q>` — a symbol plus its immediate callers/callees.
- `explore <names…>` — several symbols at once.
- `files <path>` — files under a path with symbol counts.
- `index [--full|--changed]` / `status` — build / inspect the graph.

Refresh with `/p-graph:sync`. Use the graph for candidates and for a transitive
`impact` sketch; confirm counts with grep — it costs about the same and cannot
silently miss a hit.

Then read the three markers in the output:

**1. Guessed rows.** A row printed plainly is certain: the graph knew the target's
qualified name, or it knew the receiver's type. One row can carry several call
sites, and it is marked by its most certain one — so a plain row promises that at
least one of its lines is certain, not all of them. A row printed under
`UNVERIFIED: …, matched by name only (guess) — …` matched on nothing but a bare
method name that happens to be unique in the repo. Treat it as a lead — open the
`file:line` and read the call before reporting it — and say which rows were
guesses.

**2. `impact` is a floor, not a ceiling.** It follows certain edges only. When it
refuses a guessed edge it prints a line like this:
`1 guessed edge (receiver type unknown) near this target was not followed, so a real impact through one may be missing.`
`--json` gives the same count as `skipped_guesses`. So `(no impact)` does not
mean nothing depends on the symbol.

**3. The gap banner.** `callers` / `callees` / `impact` / `context` end with
`⚠ N call sites missing from this answer` when a call site's bare name matches at least one
repo symbol and, if the call site wrote a package qualifier, that qualifier could name a real
repo package. One matching symbol is enough — the name does not need to be shared by two or
more symbols. `WriteRune` matches only one symbol in the whole of hugo, and hugo's real
`w.delegate.WriteRune(r)` call site still shows up as a gap, because the graph has no type to
check and cannot confirm that the one candidate is the real target.
`callers`, `impact` and `context` also list a resolved call that has no caller
symbol to show (made at module scope, or inside a non-definition callback);
`callees` does not have that case. Gaps are grouped — listed rows are worth
checking, the two counted groups are scale. Pass the banner on and grep to
confirm. `status` shows the repo-wide share as `unattributed calls N/M`.

Ask by bare name — one call, not two. `callers`, `callees`, `impact`, `context`,
`trace` and `explore` all resolve an id, a bare name or a `qname` (`node` is the
exception: id or `qname`). A bare name shared by several symbols merges them, and
the answer says so on its first line: `target: 2 symbols named Get`, plus the
qnames to ask by if you need one of them.
