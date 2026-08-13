## p-graph — a code knowledge graph for structural questions, checked with grep

This repo has a `pgraph` code knowledge graph. For a natural-language structural
question ("who calls X", "what breaks if I change Y", "how does X reach Y"), run
`/p-graph:query <question>` — it picks the right commands and answers with
`file:line` citations. To drive the CLI yourself, run via Bash:
`node ${CLAUDE_PLUGIN_ROOT}/tools/pgraph.mjs <cmd>` — or the `pgraph` wrapper if
installed. Use the graph to find candidates fast and to get a transitive
`impact` sketch in one call. Use grep/Read for literal text (string contents,
comments, log messages).

**Do not double-check a graph answer out of habit.** Every `callers`, `callees`,
`impact` and `context` answer ends by saying whether it is short, and the two
endings mean opposite things:

| The answer ends with | What it means | What to do |
|---|---|---|
| `✓ complete — …` | the graph found nothing missing | **stop. Do not grep. Report the list as it stands.** |
| `✓ no gaps — but every row above is a guess …` | nothing is missing, and nothing is settled either | do not grep for more rows; **open the rows you have** and say which survived |
| `⚠ N call sites missing from this answer` | the graph knows it is short | grep to close the gap, then report both |
| `no symbol named X in the graph` | nothing carries that name | check the spelling with `pgraph search X` — this is **not** "nothing calls it" |
| `ℹ N call sites reach this method through I` | the calls are written on an interface, so no call names this method | **do not grep.** Report both: this method has no direct callers, and N calls reach it through `I`. Which implementation runs is a run-time decision |
| neither line | the graph is too old to build the report | treat it as short, and grep |

With `--json` the same thing is the `complete` field, and `all_guessed` is the
second line above. Re-running a text search over a `✓ complete` answer was
measured and it changes nothing: it costs about a third more per question and
finds no extra call site.

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

**A `callers` / `callees` row is the call site.** The `file:line` on the row is where
the call is written, not where the calling function is declared, and a caller that
calls twice shows both: `svc/svc.go:10, 11`. So the row already holds what a text
search would have told you — do not go and look the line numbers up. Use
`pgraph node <qname>` if you need the caller's own signature.

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
The banner lists each `file:line`, then three counted groups it does NOT list:
same-name call sites in files that cannot see the target, call sites whose receiver
the source types as a library type, and calls the graph found nothing to link to.
`status` shows the repo-wide share.

**Only the listed rows are worth grepping for.** The three counted groups are scale,
not work: the graph has already proved they are not the target. A call on
`std::vector::size` is not a missing call site of your `Prog::size`, and going to
look for it costs money and finds nothing. **Relay the banner to the user and grep
to close the LISTED rows — never present a list as complete while they are there.**

**Ask by bare name — one call, not two.** The first line of the answer says which
symbol it resolved (`target: function svc.Get  svc/get.go:12`). If the name is shared
it says so and lists them, and only then is it worth asking again by `qname`. Do not
run `search` first to find the qualified name; the answer tells you.

Sometimes the shared symbols carry the SAME qname — a TypeScript or Python name has
no module path in it, so a monorepo can hold several. The answer then says
`They share a qname; tell them apart by file:` and lists them. Asking again cannot
separate those; read the files it names, or ask about a symbol only one of them
has.

**Write the name the way the language writes it.** C++ scope with `::` is understood:
`WriteBatchInternal::Count` and `leveldb::WriteBatchInternal::Count` both work, as does
the bare `Count`. Any tail of a qualified name works in any language, so `Store.Get`
finds `pkg.Store.Get`.

**Freshness:** structural queries **auto-refresh** the graph before answering —
`pgraph` reindexes any changed files first, so a query never answers from a stale
graph and manual syncing is normally unnecessary. To skip the refresh (answer from
the graph as-is), pass `--stale-ok` or set `PGRAPH_AUTOREFRESH=0`; when the graph
is stale you'll get a one-line `⚠ p-graph STALE` note on stderr. With the refresh
skipped right after a plugin upgrade, a query can exit `4` with
`{"error":"graph_erased"}`: the old graph was erased and not rebuilt, so it holds
nothing. **That is not an empty answer — never report "no callers" for it.** Run
`/p-graph:sync` and ask again. `/p-graph:sync`
is still available for an explicit full rebuild (`index --full`) and to warm the
graph after a pull.
