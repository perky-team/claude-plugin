## p-graph — a code knowledge graph for structural questions, checked with grep

This repo has a `pgraph` code knowledge graph. For a natural-language structural
question ("who calls X", "what breaks if I change Y", "how does X reach Y"), run
`/p-graph:query <question>` — it picks the right commands and answers with
`file:line` citations. To drive the CLI yourself, run via Bash:
`node ${CLAUDE_PLUGIN_ROOT}/tools/pgraph.mjs <cmd>` — or the `pgraph` wrapper if
installed. Use the graph to find candidates fast and to get a transitive
`impact` sketch in one call. Use grep/Read for literal text (string contents,
comments, log messages) and to confirm any answer that carries the gap banner
below — a text search costs about the same and cannot silently miss a hit.

| Question | Command |
|---|---|
| Where is symbol X defined? | `pgraph search X` then `pgraph node X` |
| What calls Y? | `pgraph callers Y` |
| What does Y call? | `pgraph callees Y` |
| What breaks if I change Z? | `pgraph impact Z` |
| How does X reach Y? | `pgraph trace X Y` |
| Focused overview of a symbol | `pgraph context X` |
| Several symbols at once | `pgraph explore A B C` |
| What files are under path/ | `pgraph files path/` |

**How much a row is worth.** A row printed plainly is **certain**: the graph knew the
target's qualified name, or it knew the receiver's type. A row printed under
`UNVERIFIED: …, matched by name only (guess) — …` is a **guess**: the only thing that
matched was a bare method name that happens to be unique in this repo. **Treat a guess
as a lead: open the `file:line`, read the call, and say in your answer which rows were
guesses.** Never fold them into the certain list.

**`impact` is a floor, not a ceiling.** It follows certain edges only and never walks a
guess, so a real dependency can be missing. When it refuses one it prints a line like
`1 guessed edge (receiver type unknown) near this target was not followed, so a real impact through one may be missing.`
and `--json` gives the same count as `skipped_guesses`. `(no impact)` is not proof that
nothing depends on the symbol.

**Completeness.** An unresolved call shows up in the gap report as soon as its bare name
matches **one** repo symbol — it does not need to be shared by two or more — and, when the
call site wrote a package qualifier, that qualifier could name a real repo package.
`callers`, `callees`, `impact` and `context` print
`⚠ N call sites missing from this answer` with each `file:line`, plus a count of
same-name call sites in files that cannot see the target and a count of calls the graph found
nothing to link to; `status` shows the repo-wide share. Gaps are grouped —
listed rows are worth checking, the two counted groups are scale. **Relay that
banner to the user and grep to close the gap — never present a list as complete
while it is there.**

**Ask by `qname`, not by bare name:** `callers Get` merges every symbol named `Get`.

**Freshness:** structural queries **auto-refresh** the graph before answering —
`pgraph` reindexes any changed files first, so a query never answers from a stale
graph and manual syncing is normally unnecessary. To skip the refresh (answer from
the graph as-is), pass `--stale-ok` or set `PGRAPH_AUTOREFRESH=0`; when the graph
is stale you'll get a one-line `⚠ p-graph STALE` note on stderr. `/p-graph:sync`
is still available for an explicit full rebuild (`index --full`) and to warm the
graph after a pull.
