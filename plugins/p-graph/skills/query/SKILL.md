---
name: query
description: Answer a structural question about the codebase from the code graph, with concrete file:line citations. Use for "who calls X", "what breaks if I change Y", "how does X reach Y", "where is X defined", "explain symbol X", "ask the graph", "query the code graph".
argument-hint: "<structural question>"
allowed-tools: Bash(node:*)
---

# p-graph: query

You answer one **structural** question about the codebase by running the right `pgraph`
commands and synthesizing the result — you are not a dispatcher. Every claim must trace to
actual graph output; cite concrete `file:line` locations (they render clickable). Never
invent a symbol, edge, or location.

`$ARGUMENTS` is the verbatim question. If it is empty, ask the user what they want to know
and stop.

## Step 1 — Freshness

Structural queries **auto-refresh** the graph before answering, so you normally don't need to
sync. As a cheap check, run once:

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/pgraph.mjs" status
```

- If it errors that `.pgraph/` doesn't exist, tell the user to run `/p-graph:init` first and stop.
- The status line ends with `… drift N`. If drift is large (the graph is far behind the working
  tree), mention that `/p-graph:sync` does a full rebuild — but you can still proceed, since the
  query commands below refresh incrementally on their own.

## Step 2 — Map the question to command(s)

Run every command via `node "${CLAUDE_PLUGIN_ROOT}/tools/pgraph.mjs" <cmd>`. ALWAYS use
`${CLAUDE_PLUGIN_ROOT}` — never a hardcoded or version-pinned path.

| Question | Command(s) |
|---|---|
| Where is symbol X defined? | `search X` then `node X` |
| What calls Y? | `callers Y` |
| What does Y call? | `callees Y` |
| What breaks if I change Z? | `impact Z` |
| How does X reach Y? | `trace X Y` |
| Focused overview of a symbol | `context X` |
| Several symbols at once | `explore A B C` |
| What files are under path/ | `files path/` |

**Chain calls** when the name is unknown or ambiguous: run `search X` first to resolve the exact
`qname`, then feed that to `callers` / `callees` / `impact` / `trace`. `context X` is the fastest
single call for "tell me about X" — one call returns the symbol plus its immediate callers and
callees. Pass `--json` to any read command if you want to post-process the rows: `callers`,
`callees` and `impact` return `{ <command>: [rows], unresolved: [gaps] }`.

**Ask by `qname`, never by bare name.** `callers Get` matches *every* symbol named `Get` and merges
their callers into one list with no marker. `callers store.Postgres.Get` asks about one symbol.

## Step 3 — Report the gaps, always

The graph resolves a call only when it can name exactly one target. A call it cannot pin down —
a method on an interface, on a parameter, on a local variable, or any ambiguous bare name — is
**dropped**, and `callers` / `impact` / `trace` walk resolved calls only. So a short list is not
proof of a short list.

`callers`, `callees`, `impact` and `context` therefore print, after the rows:

```
⚠ 3 unattributed call sites — this answer may be incomplete:
    internal/api/server.go:41  api.Server.HandleList -> ListGroups
```

**You MUST pass this on to the user whenever it appears** — the count, and the `file:line` of each
gap. Never present a list as complete while the banner is there. Say plainly that the graph could
not attribute those call sites and that a text search (grep for the bare name) is needed to close
the gap. If the user's question is "did I find every call site?", the honest answer with a banner
present is: **no — here is what the graph found, and here is where it gave up.**

`status` ends with `unattributed calls N/M`. A high share means treat every structural answer in
that repo as a lead, not as proof.

## Step 4 — Synthesize the answer

Read the output and compose a concise answer — usually a short paragraph or a tight list, not a
raw dump. Cite the concrete `file:line` from the output for each claim. Output rows are formatted
`kind qname  file:line  signature`. `(no matches)` means no symbol carries that name. `(no impact)`
and `(no path)` mean the graph found nothing **along resolved calls** — check the banner before
calling that an answer. A `⚠ p-graph STALE` line on stderr means the auto-refresh couldn't run —
say so and suggest `/p-graph:sync`.

## When the graph can't answer

Say so plainly and point elsewhere — don't guess:

- **Symbol not found** — `search` prints `(no matches)` or `node` says `symbol not found`. The
  name may be misspelled, or external (stdlib / third-party symbols have no node in the graph),
  or the graph is stale (suggest `/p-graph:sync`).
- **The question is "have I found them all?"** — the graph alone cannot answer that. Use it to
  find the call sites fast, then grep the bare name to confirm the count. Interface methods are
  the known weak spot: a call through an interface field carries no type the graph can follow.
- **The question is about literal text** — string contents, comments, log messages, config values
  — rather than code structure. The graph only knows symbols and call/import edges; point the user
  to grep / Read for text search.

The answer is **ephemeral** — return it in the conversation only. p-graph has no page store: do
**not** write the answer to a file and do **not** offer to promote it.
