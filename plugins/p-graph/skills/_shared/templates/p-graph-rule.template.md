## p-graph — prefer the code graph over grep for structural questions

This repo has a `pgraph` code knowledge graph. For **structural** questions use
`pgraph` (run via Bash: `node ${CLAUDE_PLUGIN_ROOT}/tools/pgraph.mjs <cmd>` — or
the `pgraph` wrapper if installed). Use grep/Read only for literal text (string
contents, comments, log messages).

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

**Freshness:** the graph does not auto-update. If `pgraph status` reports drift,
or you changed code this session, run `/p-graph:sync` before trusting structural
answers — a stale graph that answers confidently wrong is worse than grep.
