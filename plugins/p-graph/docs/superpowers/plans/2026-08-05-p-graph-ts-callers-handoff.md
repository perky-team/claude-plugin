# p-graph: give TypeScript call sites a caller

**Read this first. It is the whole context — do not re-derive it.**

State at handoff: `main` at `v6.2.0`, p-graph **1.2.0**, working tree clean, whole
suite green (`npm test`: 2,382 passed / 23 skipped). Precision work is **finished
and closed** — see "Do not reopen" at the bottom.

## The problem, measured

In TypeScript repos, most call sites cannot name their caller. Measured on the
pinned clones with the shipped code:

| Repo | Language | Call sites with **no caller** | Files producing **no symbols** |
|---|---|---|---|
| sindresorhus/got | TS | **11,454 / 14,329 (80%)** | 15 / 85 |
| nestjs/nest | TS | **28,448 / 38,315 (74%)** | 393 / 1,728 |
| gohugoio/hugo | Go | 4,936 / 55,499 (9%) | 38 / 930 |
| pallets/flask | Python | 230 / 3,905 (6%) | 17 / 83 |
| psf/requests | Python | 95 / 2,684 (4%) | 7 / 37 |
| caddyserver/caddy | Go | 474 / 23,642 (2%) | 6 / 326 |
| google/leveldb | C++ | 1 / 9,241 (0%) | 4 / 132 |

Of nest's callerless calls, **4,880 are already resolved** — the graph knows what
was called and cannot say who called it. Those rows are reported honestly, as
`outside any indexed symbol` gap rows, so nothing is silent. They are just absent
from the answer to the plugin's main question.

**Cause.** A function passed as a call ARGUMENT is not indexed as a definition. In
TypeScript nearly all test code lives in one (`describe('x', () => …)`,
`it('y', async () => …)`), so every call inside it has no enclosing symbol.
`plugins/p-graph/tools/lib/parse/lang/ts.scm` indexes a function declaration, a
class, a method, a `const f = () => …` and a class expression — never an argument.

## The rule, and the trap that decides it

Run this probe before writing anything; it is the whole design in six lines. A
fixture with both shapes, indexed by the shipped code:

```ts
export function target() { return 1; }
export function named(xs: number[]) {
  return xs.map(x => target() + x);   // inline arrow INSIDE a named function
}
describe('suite', () => {
  it('case', () => { target(); });    // call-argument arrow at module scope
});
```

Today's answer, verified:

```
callers of target():
   line 3 -> caller: named
   line 7 -> caller: (none — outside any indexed symbol)
```

Line 3 is **already right and useful**, and a naive fix breaks it: index every
call-argument function and `callers target` reports an anonymous arrow instead of
`named` — and `impact target` then STOPS there, because nothing calls an arrow that
is passed as a value. Line 7 is the one to fix.

**So the rule is:** index a call-argument function only when **no named definition
encloses it** (a `describe`/`it` callback at module scope qualifies; an arrow inside
`named` does not). A callback nested inside another such callback should attribute to
the innermost one — `it` inside `describe` — which the existing
`defs.filter(within).sort(innermostFirst)[0]` gives for free once both are defs.

**Naming.** These functions have no name, but the call beside them carries a string:
`it('case', …)` → `it:case`. In `callers` output that reads as the test's name, which
is what a human wants to see. Fall back to `<callee>@<line>` when the first argument
is not a string literal. Two identical names in one file are fine — the driver
already assigns an `ord` for the node id — but check what a duplicate qname does to
Pass A before assuming (it refuses a non-unique qname, which is harmless here since
nothing resolves a call *to* a test callback).

## Where the code is

- `plugins/p-graph/tools/lib/parse/lang/ts.scm` — add the capture. The shape is
  `(call_expression arguments: (arguments [(arrow_function) (function_expression)]))`.
  **Verify any pattern against the vendored grammar before trusting it**: an invalid
  pattern does not merely fail to match, it takes the whole query file down. One line
  of a previous plan was wrong exactly this way (`(formal_parameters (identifier))`).
- `plugins/p-graph/tools/lib/parse/driver.mjs`, the `for (const def of defs)` loop
  (search `const ordSeen`) — where a name and qname are assigned. `defs` entries keep
  `.node`, so the enclosing-call string argument is reachable from there.
- The same file's `KIND_SPECIFICITY` dedup collapses defs with identical spans. An
  arrow and its enclosing call do not share a span, so this should not fire — confirm
  it with a two-callback fixture rather than by reading.

## What to measure, and what will move

`node plugins/p-graph/scripts/measure.mjs --no-clone` (clones live under
`$TMPDIR/pgraph-measure` unless `--work` says otherwise; the pinned SHAs are in the
script). It exits non-zero if one certain row lacks a reason read from the source.

Expect these to change, and record them:

- nest `TestingModule.createNestApplication` — 190 rows today, 184 gap rows. Most of
  those gap rows should become caller rows named after their test.
- got `end`, `exec`, `setHeader` — 826, 92 and 88 gap rows today.
- The audit may need a reason for a caller that is a callback; add it read from the
  SOURCE, never from the graph's own tables (that is the rule the whole script rests
  on — see its `REASONS` list and `ACCEPTED` map).
- Node counts grow a lot on TS repos (nest has 393 zero-symbol files). Report the new
  node count and database size, and check `search` did not become noisy with test
  callbacks.

## Do not reopen

Precision is done: 1,619 resolved rows over 22 symbols, 1,411 certain, **0 false
among certain**, at most 31 false overall (1.9%, from 42.9% before this work). The
remaining 31 are spread over four causes that each need type INFERENCE rather than
type reading — Go positional results, Python attribute types, TypeScript contextual
callback types, a C++ type table. Each next unit of work buys about ten rows. The
full list with numbers is in `2026-08-04-p-graph-follow-up.md`.

One more thing nobody has done: every number in this repo comes from seven
open-source repositories. The plugin has never been measured on the user's own code.
`pgraph index --full` plus `status` there costs half an hour and would say more than
another point of precision.
