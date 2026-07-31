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

**Completeness:** the graph links a call by matching names, not by checking types.
A genuinely ambiguous bare name — shared by two or more repo symbols, with nothing
to tell them apart — is left unresolved, and `callers` / `impact` / `trace` walk
resolved calls only. A call through an interface, a parameter, or a local variable
has no type the graph can check: when its bare name is unique it still links,
silently, with no guarantee the receiver is the type it names. `callers`,
`callees`, `impact` and `context` print
`⚠ N call sites missing from this answer` with each `file:line`, plus a count of
same-name call sites in files that cannot see the target and a count of calls
that leave the repo; `status` shows the repo-wide share. Gaps are grouped —
listed rows are worth checking, the two counted groups are scale. **Relay that
banner to the user and grep to close the gap — never present a list as complete
while it is there.** Ask by `qname`, not by bare name: `callers Get` merges every
symbol named `Get`.

**Freshness:** structural queries **auto-refresh** the graph before answering —
`pgraph` reindexes any changed files first, so a query never answers from a stale
graph and manual syncing is normally unnecessary. To skip the refresh (answer from
the graph as-is), pass `--stale-ok` or set `PGRAPH_AUTOREFRESH=0`; when the graph
is stale you'll get a one-line `⚠ p-graph STALE` note on stderr. `/p-graph:sync`
is still available for an explicit full rebuild (`index --full`) and to warm the
graph after a pull.
