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
`callees` and `impact` return `{ <command>: [rows], gaps: [gap rows] }`.

**Ask by `qname`, never by bare name.** `callers Get` matches *every* symbol named `Get` and merges
their callers into one list with no marker. `callers store.Postgres.Get` asks about one symbol.

## Step 3 — Report the gaps, always

The graph resolves a call by matching names, not by checking types. A genuinely ambiguous bare
name — used by two or more repo symbols, with nothing to tell them apart — is left **unresolved**
and shows up in the gap report below. A call through an interface, a parameter, or a local
variable carries no type the graph can check, so when its bare name happens to be unique in the
repo, the call still links — silently, with no warning, and possibly to the wrong symbol. So a
short list, even a **clean** one with no banner at all, is not proof that every row is correct.

`callers`, `callees`, `impact` and `context` therefore print, after the rows:

```
⚠ 3 call sites missing from this answer:
    internal/api/server.go:41  api.Server.HandleList -> ListGroups
    internal/api/server.go:58  api.Serve -> bp.ListGroups
    web/boot.ts:12  outside any indexed symbol -> start
  + 12 same-name call sites in files that do not import the target's package — likely unrelated, not listed.
  + 365 calls that leave the repo (stdlib, third party, builtins) — nothing to link.
  Confirm with a text search before treating this answer as complete.
```

**You MUST pass this on to the user whenever it appears** — the listed `file:line` rows and both
counts. Never present a list as complete while the banner is there. The listed rows are the ones
worth checking by hand; the two counted groups are for scale, and you should say what they are
rather than hiding them.

A resolved row is a strong lead, not a fact: the graph matches names, not types. If the user's
question is "did I find every call site?" or "is this safe to change?", the honest answer is: here
is what the graph found, here is where it gave up — now confirm with a text search.

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
  find the call sites fast, then grep the bare name to confirm the count. Interface calls are the
  known risk: the graph has no type for the receiver, so a unique bare name still links — even to
  the wrong type — and no banner marks it. A parameter or local variable behaves the same way.
- **The question is about literal text** — string contents, comments, log messages, config values
  — rather than code structure. The graph only knows symbols and call/import edges; point the user
  to grep / Read for text search.

The answer is **ephemeral** — return it in the conversation only. p-graph has no page store: do
**not** write the answer to a file and do **not** offer to promote it.
