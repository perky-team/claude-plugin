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
- The status line carries `- drift N -`, counting only the files a refresh would actually
  reparse. If drift is large (the graph is far behind the working tree), mention that
  `/p-graph:sync` does a full rebuild — but you can still proceed, since the query commands
  below refresh incrementally on their own.
- If the status line ends with `- rebuild pending (schema upgrade)`, the stored graph was dropped
  because the code's schema is newer than the one on disk. The next query (or `/p-graph:sync`)
  rebuilds it from scratch — say so, and expect that first run to be slower than usual.
- In that state, a query run with the refresh skipped (`--stale-ok` or `PGRAPH_AUTOREFRESH=0`)
  exits `4` and prints `{"error":"graph_erased"}` instead of rows. The graph holds nothing, so
  **this is not an empty answer** — run `/p-graph:sync` and ask again, and never report it as
  "no callers".

## Step 2 — Map the question to command(s)

Run every command via `node "${CLAUDE_PLUGIN_ROOT}/tools/pgraph.mjs" <cmd>`. ALWAYS use
`${CLAUDE_PLUGIN_ROOT}` — never a hardcoded or version-pinned path.

| Question | Command(s) |
|---|---|
| Where is symbol X defined? | `search X` then `node X` |
| What calls Y? | `callers Y` |
| What does Y call? | `callees Y` |
| What breaks if I change Z? | `impact Z` (a floor, not a ceiling — see Step 3) |
| How does X reach Y? | `trace X Y` |
| Focused overview of a symbol | `context X` |
| Several symbols at once | `explore A B C` |
| What files are under path/ | `files path/` |

**Chain calls** when you do not know the name at all: run `search X` first to find it, then feed
that to `callers` / `callees` / `impact` / `trace`. A name you do know needs no `search` first, even
when it is shared — see "A bare name is one call, not two" below. `context X` is the fastest
single call for "tell me about X" — one call returns the symbol plus its immediate callers and
callees. Pass `--json` to any read command if you want to post-process the rows: `callers`,
`callees` and `impact` return `{ <command>: [rows], gaps: [gap rows] }`. A `callers` or `callees`
row carries a `guess` field — 0 is certain, 1 is matched by name only. Every gap row carries
`reason` and `reachable`. `impact` walks certain edges only, and adds `skipped_guesses`: the number
of guessed edges it refused to follow. `context --json` returns
three gap lists: `gaps_in` (calls that name this symbol), `gaps_out` (calls this symbol makes), and
`gaps` — the two merged with duplicates removed. Read `gaps`: a wrapper-delegation call (a method
that calls a same-named method on one of its own fields) can show up in both `gaps_in` and
`gaps_out` for the same call site, and `gaps` has already removed the duplicate.

**A bare name is one call, not two.** `callers`, `callees`, `impact`, `context`, `trace` and
`explore` each resolve an id, a bare name or a `qname`, so `callers Get` works and you do not need
`search` first. (`node` is the exception — it takes an id or a `qname`.) A bare name shared by
several symbols does merge them into one list, and `callers`, `callees` and `impact` say so on
their first line: `target: 2 symbols named Get`, plus the qnames to ask by. Read that line, and ask
again by `qname` (`callers store.Postgres.Get`) if you need one of them. The other three name what
they resolved in their own words: `context` prints the declaration row of every symbol the name
carries, `explore` prints one row per symbol, and `trace` names both ends in the route it prints.

## Step 3 — Read the three markers, and relay them

Three things in the output tell you how much a row is worth. Handle all three.

### 3a — Certain rows are the answer; guessed rows are leads

Rows printed plainly are **certain**: the graph knew the target's qualified name, or it knew the
receiver's type. One row can carry several call sites, and it is marked by its **most certain** one,
so a plain row promises that **at least one** of its lines is certain — not all of them. A guessed
call site can print beside a certain one with nothing to mark it. Rows printed under this heading
are **guesses**, every line on them:

```
UNVERIFIED: 1 more caller, matched by name only (guess) — the graph could not see the receiver's type, so this one may be a different symbol with the same method name:
    method app.Server.Guessed  app/app.go:28  func (s *Server) Guessed() {
```

A guessed row matched on nothing but a bare method name that is unique in the repo. It may be
right, and it may name a completely unrelated symbol. **Open the `file:line` and read the call
before you report a guessed row as a caller.** Say which rows were guesses. Never merge them into
the certain list.

Where guesses come from most often: a receiver whose type comes from a function's return value
(`x := reflect.ValueOf(...)`), and any call on a value in TypeScript, JavaScript, Python or C++,
where no type is recorded at all.

`context` uses the same split, indented under its own `callers:` and `callees:` headers. With
`--json`, each `callers`/`callees` row carries `guess`: 0 is certain, 1 is a guess.

A row that begins with `file` is a call written outside any function — a module's top level, a Go
package-level `var x = pkg.New()`, a `@Injectable()` on a class. There is no enclosing symbol to
name, so the row names the file and carries every line on it: `file app/boot.js  3, 4`. Those are
call sites of the symbol you asked about, and the line numbers are already on the row — never grep
for them. The row obeys the same marking as any other: printed plainly, at least one of its lines is
certain; printed under `UNVERIFIED`, every line on it is a guess you open and judge like any other
guess. `impact` is stricter: it lists only the certain
ones and adds a guessed
one to `skipped_guesses`, which blocks `✓ complete`. Across ten repos 4,672 of 4,998 resolved
file-scope calls (93%) are certain, so 326 are counted instead of listed. That is also how you tell
a mixed **file** row apart — `impact` prints only its certain lines. A mixed **node** row has no
such split: `impact` prints no call sites for a node row at all, only the declaration line, so a
node row in an `impact` answer says nothing about which of its call sites are settled. Open every
line of a plain row you are about to rely on.

### 3b — `impact` is a floor, not a ceiling

`impact` follows certain edges only. It never walks a guess, so a real dependency can be missing
from its answer. When it refused any, it says so:

```
1 guessed edge (receiver type unknown) near this target was not followed, so a real impact through one may be missing.
```

`--json` gives the same count as `skipped_guesses`. Report that number. For "is this safe to
change?", `impact` alone is never a yes.

### 3c — The gap banner: relay it, always

`callers`, `callees`, `impact` and `context` print, after the rows, the call sites the answer is
missing:

```
⚠ 3 call sites missing from this answer:
    internal/api/server.go:41  api.Server.HandleList -> ListGroups
    internal/api/server.go:58  api.Serve -> bp.ListGroups
    web/boot.ts:12  file scope -> start
  + 12 same-name call sites in files that do not import the target's package — likely unrelated, not listed.
  + 365 calls the graph found nothing to link to (stdlib, third party, builtins, or a repo call it never indexed).
  Confirm with a text search before treating this answer as complete.
```

**You MUST pass this on to the user whenever it appears** — the listed `file:line` rows and both
counts. Never present a list as complete while the banner is there. The listed rows are worth
checking by hand; the two counted groups are for scale, and you should say what they are rather
than hiding them.

Every listed row is a candidate the graph could not settle, so open its line and judge it. The
middle column names the code the call sits in. `file scope` there means the call is written outside
any function — that changes nothing about how you treat it, it is still a candidate.

`status` ends with `unattributed calls N/M`. A high share means treat every structural answer in
that repo as a lead, not as proof.

A caller named `it:something`, `describe:something` or `beforeEach@42` is a TypeScript or
JavaScript function passed to another call — almost always a test or a test hook. Read it as "this
call is made by that test", and give the `file:line` beside it, which is the place to look.

If the user asks "did I find every call site?" or "is this safe to change?", the honest answer is:
here is what the graph is sure of, here is what it guessed, here is where it gave up — now confirm
with a text search.

## Step 4 — Synthesize the answer

Read the output and compose a concise answer — usually a short paragraph or a tight list, not a
raw dump. Cite the concrete `file:line` from the output for each claim. Output rows are formatted
`kind qname  file:line  signature`. `(no matches)` means no symbol carries that name. `(no path)`
means the graph found nothing along resolved calls — and when one END of a `trace` is a name nothing
carries, you get `no symbol named X in the graph` instead, which is a different answer and never
`(no path)`. `(no impact)` means it found nothing along
**certain** calls, which is narrower — check the banner and the `skipped_guesses` line before
calling either one an answer. A `⚠ p-graph STALE` line on stderr means the auto-refresh couldn't
run — say so and suggest `/p-graph:sync`.

## When the graph can't answer

Say so plainly and point elsewhere — don't guess:

- **Symbol not found** — `search` prints `(no matches)` or `node` says `symbol not found`. The
  name may be misspelled, or external (stdlib / third-party symbols have no node in the graph),
  or the graph is stale (suggest `/p-graph:sync`).
- **The question is "have I found them all?"** — the graph alone cannot answer that. Use it to
  find the call sites fast, then grep the bare name to confirm the count. The certain rows are
  reliable; the guessed rows and the gap banner are where the count moves.
- **The question is about literal text** — string contents, comments, log messages, config values
  — rather than code structure. The graph only knows symbols and call/import edges; point the user
  to grep / Read for text search.

The answer is **ephemeral** — return it in the conversation only. p-graph has no page store: do
**not** write the answer to a file and do **not** offer to promote it.
