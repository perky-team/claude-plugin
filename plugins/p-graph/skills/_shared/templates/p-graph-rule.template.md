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
| `⚠ N call sites missing from this answer` | the graph knows it is short, and it names each missing row with its own `file:line` — the first 20, then `… and N more` for the rest | **every printed row is a candidate the graph could not settle: open that line and judge it.** The middle column names the code the call sits in; `file scope` means the call is written outside any function, and that is still a candidate, not a confirmed call site. Never grep for a line the banner has already named |
| `no symbol named X in the graph` | nothing carries that name | check the spelling with `pgraph search X` — this is **not** "nothing calls it" |
| `ℹ N call sites reach this method through I` | the calls are written on an interface, so no call names this method | **do not grep.** Report both: this method has no direct callers, and N calls reach it through `I`. Which implementation runs is a run-time decision |
| `ℹ N call sites of this method — on I, which implements it` | these ARE call sites of the method you asked about — `I` is the concrete type the graph resolved each one to | **do not grep.** Put them in your main list of call sites, and name `I` as the implementing type. Nothing here is missing or needs a text search |
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

One row can carry several call sites, and it is marked by its **most certain** one. So a
plain row promises that **at least one** of its lines is certain, not all of them — a
guessed call site can print beside a certain one with nothing to mark it. `impact` splits
them, because it lists only the certain ones. Measured on a two-call file: `callers`
prints `file app/boot.js  3, 4` plainly, `impact` prints `file app/boot.js  3` and says
one guessed edge was not followed — so line 4 is the guess.

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
look for it costs money and finds nothing. **Relay the banner to the user and settle
the LISTED rows — never present a list as complete while they are there.**

**Settle a listed row by reading it, not by searching for it.** The banner already
gives every listed row a `file:line`, so open that line. A text search for a line the
banner has already named buys nothing and costs a whole extra pass.

**A `file` row is a call site, not a gap.** A call written outside any function — a
module's top level, a Go package-level `var x = pkg.New()`, a `@Injectable()` on a
class — has no enclosing symbol to name, so `callers`, `context` and `impact` name the
**file** that holds it and put every line on one row: `file app/boot.js  3, 4`. The
line numbers are already on the row, so never grep for them. Such a row is marked like
any other, and the same "most certain one" rule applies: printed plainly at least one
of its lines is certain, printed under `UNVERIFIED: … (guess)` every line on it is a
guess. `impact` is stricter, and it is what tells a mixed row apart — it lists only the
certain call sites and adds a guessed one to its `guessed edge … not followed` count,
which also stops it saying `✓ complete`.
Across ten repos 4,672 of 4,998 resolved file-scope calls (93%) are certain, so 326
are counted instead of listed.

These calls used to be named one per line in the `⚠` banner, and that banner stops at
20 rows. Measured on hugo: `callers parse.mkItem` named 20 of its 120 file-scope call
sites and replaced the rest with `… and 100 more`. Across axios, nest, got and hugo,
13 symbols were over that cap and 1,500 call sites were named nowhere at all. Now
`parse.mkItem` is one row carrying all 120 lines, and it says `✓ complete`. On axios,
`callers InterceptorManager.eject` listed 17 call sites and named 8 in the banner; it
now lists all 25 — 11 certain and 14 guesses — and says `✓ complete`.

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
