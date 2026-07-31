## p-graph — prefer the code graph over grep for structural questions

This repo has a `pgraph` code knowledge graph. For a natural-language structural
question ("who calls X", "what breaks if I change Y", "how does X reach Y"), run
`/p-graph:query <question>` — it picks the right commands and answers with
`file:line` citations. To drive the CLI yourself, run via Bash:
`node ${CLAUDE_PLUGIN_ROOT}/tools/pgraph.mjs <cmd>` — or the `pgraph` wrapper if
installed. Use grep/Read only for literal text (string contents, comments, log
messages).

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

**Completeness:** the graph links a call only when it can name exactly one target.
A call it cannot type — a method on an interface, a parameter, a local variable, or
any ambiguous bare name — is dropped, and `callers` / `impact` / `trace` walk
resolved calls only. `callers`, `callees`, `impact` and `context` print
`⚠ N unattributed call sites` with each `file:line` when that happened; `status`
shows the repo-wide share. **Relay that banner to the user and grep to close the
gap — never present a list as complete while it is there.** Ask by `qname`, not by
bare name: `callers Get` merges every symbol named `Get`.

**Freshness:** structural queries **auto-refresh** the graph before answering —
`pgraph` reindexes any changed files first, so a query never answers from a stale
graph and manual syncing is normally unnecessary. To skip the refresh (answer from
the graph as-is), pass `--stale-ok` or set `PGRAPH_AUTOREFRESH=0`; when the graph
is stale you'll get a one-line `⚠ p-graph STALE` note on stderr. `/p-graph:sync`
is still available for an explicit full rebuild (`index --full`) and to warm the
graph after a pull.
