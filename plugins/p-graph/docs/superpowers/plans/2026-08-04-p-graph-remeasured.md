# p-graph 1.0.0: the published numbers, re-measured from scratch

The figures in `README.md` and in `2026-08-01-p-graph-correct-answers-results.md`
were measured while the work was being built. This file re-measures them **on
fresh clones, with the shipped code, in one sitting**, so the claims can be
audited from the repo instead of from a working folder on one machine.

It also replaces what used to be follow-up item 11: the row-level evidence for
"no certain row was false" now lives here.

**Numbers moved after this was written.** A receiver typed by a function's result
now resolves through the callee's signature, which removed 27 false rows and turned
thousands of guesses into certain ones. The current figures are 1,707 resolved,
1,355 certain, 352 guessed — see "A receiver typed from a function's return value"
in `2026-08-04-p-graph-follow-up.md`. Everything below describes the run that came
first; the method, the audit and the eight hand-read rows are unchanged, and the
script prints today's numbers.

## Run it again

```bash
node plugins/p-graph/scripts/measure.mjs              # all seven, clones what is missing
node plugins/p-graph/scripts/measure.mjs --repos hugo,nest
node plugins/p-graph/scripts/measure.mjs --no-clone   # reuse clones already on disk
```

The script pins each repository to the commit below, so its numbers are the numbers
in this file. It **exits non-zero** if one certain row has no reason to mean the
symbol it names — the invariant the whole design rests on. Rows that have no
mechanical reason but were read and found correct live in its `ACCEPTED` list with
the reason; anything new fails the run.

## What was run

Seven repositories, cloned fresh (`--depth 1`) and indexed with `index --full`:

| Repo | Commit | Files | Index |
|---|---|---|---|
| gohugoio/hugo | `70db201` | 930 indexed | 17.0 s |
| caddyserver/caddy | `e096ca9` | 326 | 6.0 s |
| nestjs/nest | `20ad6fd` | 1,728 | 49.5 s |
| pallets/flask | `6a2f545` | 83 | 1.7 s |
| psf/requests | `1f6589e` | 37 | 1.0 s |
| sindresorhus/got | `e3924aa` | 85 | 2.8 s |
| google/leveldb | `7ee830d` | 132 | 9.4 s |

The same 22 symbols the original measurement used: 6 Go in hugo, 3 Go in caddy,
3 TypeScript in got, 3 in nest, 3 Python in requests, 2 in flask, 2 C++ in
leveldb.

## Per-symbol answer size

"Resolved" is every call edge that reached the symbol. "Claimed" is the number in
the published table.

| Symbol | Repo | Resolved now / claimed | certain / guess | gap rows |
|---|---|---|---|---|
| `bufferpool.GetBuffer` | hugo | 24 / 24 | 24 / 0 | 0 |
| `goldmark.idFactory.Put` | hugo | 1 / 1 | 0 / 1 | 11 |
| `collections.Namespace.Index` | hugo | 37 / 37 | 0 / 37 | 53 |
| `highlight.byteCountFlexiWriter.WriteRune` | hugo | 3 / 3 | 0 / 3 | 10 |
| `helpers.Exists` | hugo | 11 / 11 | 11 / 0 | 7 |
| `hugolib.Test` | hugo | 982 / 982 | 982 / 0 | 4 |
| `caddy.ParseDuration` | caddy | 65 / 65 | 65 / 0 | 3 |
| `caddyhttp.SanitizedPathJoin` | caddy | 7 / 7 | 7 / 0 | 0 |
| `caddy.ParseStructTag` | caddy | 1 / 1 | 1 / 0 | 0 |
| `end` | got | 1 / 1 | 1 / 0 | 826 |
| `exec` | got | 0 / 0 | 0 / 0 | 92 |
| `setHeader` | got | 91 / 91 | 2 / 89 | 81 |
| `TestingModule.createNestApplication` | nest | 190 / 190 | 0 / 190 | 184 |
| `isUndefined` | nest | 75 / 75 | 75 / 0 | 2 |
| `isObject` | nest | 44 / 44 | 44 / 0 | 6 |
| `get` | requests | 84 / 84 | 84 / 0 | 85 |
| `RequestsCookieJar.set` | requests | 38 / 38 | 1 / 37 | 0 |
| `RequestsCookieJar.update` | requests | 16 / 16 | 0 / 16 | 0 |
| `url_for` | flask | 50 / 50 | 50 / 0 | 1 |
| `get_flashed_messages` | flask | 6 / 6 | 6 / 0 | 0 |
| `leveldb.DBImpl.Get` | leveldb | 0 / 0 | 0 / 0 | 134 |
| `TotalFileSize` | leveldb | 8 / 8 | 0 / 8 | 0 |
| **Total** | | **1,734 / 1,734** | **1,353 / 381** | |

Every symbol matches. One row moved inside its total: got's `end` is now
**certain** where the published table has it as a guess. That row was already the
one real call site, and the lexical-scope pass that shipped with 1.0.0 can see
its target is declared in the same scope — so 1,352 certain rows became 1,353.

## The certain rows, audited

The strong claim is that **no certain row is false**. Checking that needs a reason,
per row, why the call site means *this* symbol and not a same-named one elsewhere.
All 1,353 were checked, in two steps.

**Step 1 — mechanical, 1,345 of 1,353.** Each row had at least one of:

| Reason | What it proves |
|---|---|
| the target is in the calling file | the name resolves in that file's own scope |
| the line writes `<pkg>.<Name>` (Go) | the source itself named the package |
| the calling file is in the target's package (Go) | a package-level name, resolved inside its package |
| the line writes `<alias>.<Name>` and the file imports that package (Go) | same as above, through an import alias |
| the line writes `<module>.<Name>` and the target sits in that module (Python) | the source named the module |
| the calling file imports the target's file | the name was brought in on purpose |

**Step 2 — by hand, the remaining 8.** All 8 are flask's `url_for`, called with no
qualifier from a file in another directory:

| Call site | Verdict |
|---|---|
| `examples/tutorial/flaskr/auth.py:25, 77, 105, 116` | correct — line 10 is `from flask import url_for` |
| `examples/tutorial/flaskr/blog.py:81, 108, 125` | correct — line 7 is `from flask import url_for` |
| `tests/test_converters.py:26` | correct — line 5 is `from flask import url_for` |

**0 of 1,353 certain rows false.** The claim holds on fresh clones.

Worth naming: those 8 rest on the same mechanism that produced the one false
certain row found in p-graph's own source — a Python or JS top-level function has a
bare qname, so a bare call can match it across files. Here every one is right
because the file really imports the name. The lexical-scope pass prefers a
definition in scope, but when there is none, a cross-file bare-name match is still
accepted and still called certain.

**Why that is not "fixed" by requiring an import.** Two measurements say the naive
version costs far more than it buys. On p-graph's own source, 52 certain rows were
cross-file with no import; 50 were correct (functions handed in through a `ctx`
object under the same name) and 2 were the shadowing bug, which the lexical-scope
pass fixes properly. And a file-level import check cannot work at all for a
re-export barrel (`import { x } from '../common'` where `x` is declared three
directories deeper) or for a Python package that re-exports (`from flask import
url_for`) — nest and flask are full of both, so it would demote thousands of correct
rows. Doing it right means recording imported NAMES and following `export … from`
chains, which is a real piece of extraction work, not a guard.

So the class stays, bounded and watched instead: across all seven repositories it is
**8 rows**, each listed by the measurement script, each read. The script fails on a
ninth.

## Four figures checked directly

| Claim | Re-measured |
|---|---|
| caddy database 10.5 MB | 10.5 MB |
| `impact` on hugo, 399 ms | 323 ms |
| `impact goldmark.idFactory.Put` empty, 1 guess refused | `(no impact)` + "1 guessed edge … was not followed" |
| leveldb C++ method symbols 1,198 | 1,198 |

## What this file does NOT re-verify

- The **165 false rows among guesses**. Judging those needs a human reading each
  receiver, as the original measurement did. Their counts per symbol are reproduced
  above (the `guess` column), but not their verdicts.
- The **"before" column** (2,767 resolved rows, 42.9% false). That needs the
  pre-plan code loaded against the same clones.
- The **1,724 real call sites** found by text search, and so the 2 silent misses.
  Reproducing that means re-reading every grep hit by receiver.
