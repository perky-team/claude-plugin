# p-graph Correct Answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make p-graph's `callers` rows right, not just honest — by giving the resolver the one thing it has never had: the receiver's type.

**Architecture:** p-graph already types one receiver shape — a struct field of the enclosing method's receiver — by recording field types at extraction and looking them up at build time. That machinery works and is guarded. This plan feeds the same machinery two more sources: the declared type of a **parameter**, and the declared or constructed type of a **local or package-level variable**. A call on a typed receiver then resolves to `<type>.<method>` or is refused outright when the type lives outside the repo. Everything the resolver still cannot type gets marked as a guess, printed under its own heading, and kept out of `impact`'s transitive walk. Two parse bugs that silently disable the existing guards are fixed first, and the languages with no qualification at all (TypeScript, JavaScript, Python, C++) get one rule that stops a bare member call from claiming a top-level symbol.

**Tech Stack:** Node >= 22.5 (`node:sqlite`), vendored web-tree-sitter WASM grammars, vitest, plain ESM `.mjs` — no new dependencies.

## Global Constraints

- **No new dependencies.** `package.json` must not change.
- **Node >= 22.5** is the floor (`node:sqlite`). Do not use newer APIs.
- **All artifacts in English**, in Simple English: short sentences, one idea each, everyday words, active voice.
- **Comments explain why, not what.** Match the existing density in `driver.mjs` and `local-sqlite.mjs`.
- **No new CLI flags, no new config options.** `--json` is the escape hatch for full data.
- **Never edit `plugins/p-graph/.claude-plugin/plugin.json`.** Version bumps happen only at release time, by the procedure in `.claude/CLAUDE.md`.
- **`SCHEMA_VERSION` ends this plan at 7.** Bump it once, in Task 3, and not again.
- **TDD is mandatory.** Write the failing test, run it, watch it fail for the right reason, then implement.
- **Run `npx vitest run plugins/p-graph` before every commit.** It must be green — **151 tests pass today**.
- **Every task ends with a commit.** Conventional-commit prefixes. Never add Claude attribution to a commit message.
- Windows + PowerShell is the working shell; the Bash tool is available for POSIX scripts. Never mix the two syntaxes in one command. **Never write a file containing `⚠`, `—` or `…` with PowerShell `Set-Content`/`Out-File`** — use the Write/Edit tools.

---

## Background: what is wrong, measured

Two independent evaluations ran p-graph against gohugoio/hugo, nestjs/nest, pallets/flask, caddyserver/caddy and google/leveldb, hand-checked thousands of call sites, and compared against `gopls` as ground truth. The previous plan made the tool honest: of 2,438 hand-checked call sites, **zero** were hidden. This plan makes it right.

| Defect | Evidence |
|---|---|
| A call on a **parameter or a local variable** is matched by bare name with no type check | `callers goldmark.idFactory.Put` returns **12 rows and no banner**; `gopls` says the symbol has **0** references. All 12 are `sync.Pool.Put`. `collections.Namespace.Index` returns 32 rows, `gopls` says 3 — 30 of them are `reflect.Value.Index`. `highlight.byteCountFlexiWriter.WriteRune` returns 7, `gopls` says 1 |
| One false leaf edge becomes hundreds of false "impacted" symbols | `impact goldmark.idFactory.Put` returns **713 symbols — 7.2% of hugo** — seeded entirely by those 12 false edges |
| A Go method on a **generic type** loses its receiver | `func (p *Partition[K, V]) Clear()` gets qname `dynacache.Clear`. **195 of hugo's 4,154 Go methods (4.7%)**. Worse, with no `recvType` the new guards are bypassed vacuously — this is how the one surviving false builtin edge got through |
| A Go module path ending in `/vN` yields the wrong package name | `github.com/caddyserver/caddy/v2` becomes package `v2`. On caddy: **0** import edges match `%/caddy"`, so the gap report's reachability check can never fire, and 15 edges carry a `v2.*` target. Confirmed false edge: `caddy.Duration(dur)` resolves to `caddycmd.Flags.Duration` |
| In TS/JS/Py/C++ a **bare member call** claims a top-level symbol | A ten-line arrow function named `end` inside one method body is the unique `qname` match for **all 825** `.end()` calls in got. **95.6% of resolved TypeScript call sites are false.** Same shape: `exec` (82 false), `setHeader` (89), Python `get` (91), `RequestsCookieJar.set` (22) |
| C++ out-of-class definitions are not captured at all | On leveldb, **260 of 266** out-of-class method definitions are missing. `callers TotalArea` prints **nothing** — no rows, no banner, exit 0. Silence reads as "no callers" |
| `impact` regressed 11–75× | 212 ms → 2,373 ms on caddy; ~200 ms → **15,555 ms** on hugo. `gapsAround` runs one full unresolved-call scan per reached node per name variant — about 939 scans on hugo, to print 20 rows |
| Asking by bare name silently drops the whole gap report | `callers TestingModule.createNestApplication` → 184 gap rows. `callers createNestApplication` → **0**. `callers` matches `name OR qname`; `gapsFor` goes through `store.node`, which matches `id OR qname` |
| The database is mostly source text | caddy's graph is **105.6 MB** for 326 files. `signature` stores whole source lines; the longest single one is **157,787 characters** |
| `status` drift counts files the index would never read | A README edit alone shows `drift 1`; three stray `.txt` files show `drift 5`. `freshness.mjs` already has `computeActionable` for exactly this, and `status` does not use it |
| git's raw stderr leaks into every command | In a non-git tree every command, including `index` and `status`, prints `fatal: not a git repository (or any of the parent directories): .git` |
| A read-only `.pgraph` **directory** kills every command | WAL mode needs to create a `-shm` file even to read, so the read-only fallback cannot do the job it exists for. One error is double-prefixed: `pgraph: p-graph: store is read-only` |

**Where to stop if you want most of the value.** Tasks 1 to 6 remove essentially every false edge the evaluations found and undo both regressions. Tasks 7 to 9 are real but smaller. Task 10 is measurement and documentation and must always run last.

**Deliberately out of scope, for a plan of its own:** interface dispatch (indexing interface method declarations and adding `implements` edges, so a call through an interface names its possible targets instead of guessing one); TypeScript call-argument function bodies as definitions (`describe`/`it` callbacks — 394 of nest's 1,727 files produce zero symbols and 56% of resolved edges have no source symbol); and the stale file row left behind when a file is created and deleted without ever being committed, which `gitChangedFiles` cannot see.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `plugins/p-graph/tools/lib/parse/lang/go.scm` | Go captures: receivers, parameters, variable declarations | Modify (Tasks 3, 4) |
| `plugins/p-graph/tools/lib/parse/lang/cpp.scm` | C++ captures, including out-of-class definitions and qualified calls | Modify (Task 7) |
| `plugins/p-graph/tools/lib/parse/driver.mjs` | AST to nodes/edges/types. Owns every per-call-site fact and every recorded type | Modify (Tasks 3, 4, 6, 7) |
| `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs` | DDL, resolution passes, gap report | Modify (Tasks 2, 5, 6, 8) |
| `plugins/p-graph/tools/lib/cli/commands.mjs` | Output, including the confidence heading and `status` | Modify (Tasks 1, 5, 8) |
| `plugins/p-graph/tools/lib/freshness.mjs` | Drift and refresh policy | Modify (Task 8) |
| `plugins/p-graph/tools/pgraph.mjs` | Entry point, read-only fallback | Modify (Task 8) |
| `plugins/p-graph/tools/__tests__/impact-perf.test.ts` | Task 1: the frontier scan runs once per name, not once per node | Create |
| `plugins/p-graph/tools/__tests__/gap-bare-name.test.ts` | Task 2: a bare-name query reports the same gaps as a qname query | Create |
| `plugins/p-graph/tools/__tests__/go-generic-receiver.test.ts` | Task 3: a method on a generic type keeps its receiver | Create |
| `plugins/p-graph/tools/__tests__/receiver-types.test.ts` | Task 4: parameters and locals are typed; external types are refused | Create |
| `plugins/p-graph/tools/__tests__/confidence.test.ts` | Task 5: an untyped guess is marked, printed apart, and excluded from `impact` | Create |
| `plugins/p-graph/tools/__tests__/member-call-owner.test.ts` | Task 6: a member call cannot claim an unowned top-level symbol | Create |
| `plugins/p-graph/tools/__tests__/lang-cpp-outofclass.test.ts` | Task 7: header/implementation split yields symbols and edges | Create |
| `plugins/p-graph/README.md` and `skills/**` | Task 10: claims match behaviour, with fresh numbers | Modify |
| `plugins/p-graph/docs/superpowers/plans/2026-08-01-p-graph-correct-answers-results.md` | Task 10: before/after measurements | Create |

---

### Task 1: Undo the `impact` slowdown

`impact` went from about 200 ms to 15.5 seconds on hugo. Nothing about the answer got better; the cost is pure waste.

**Files:**
- Modify: `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs` (`gapsAround` and `collectGaps`)
- Create: `plugins/p-graph/tools/__tests__/impact-perf.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `store.gapsAround(name)` returns the same rows as today, but runs one query per distinct name instead of one per reached node per name variant.

- [ ] **Step 1: Find out where the time goes**

```powershell
node --input-type=module -e "import {openStore} from 'file:///C:/projects/perky.team/claude-plugin/plugins/p-graph/tools/lib/destinations/local-sqlite.mjs'; const s=openStore(process.argv[1],{readOnly:true}); const t=Date.now(); const r=s.gapsAround('bufferpool.GetBuffer'); console.log(r.length, 'rows in', Date.now()-t, 'ms'); s.close();" "<a hugo clone>/.pgraph/graph.db"
```

Record the row count and the time. Read `collectGaps` and `gapsAround` and write down, in your report, how many SQL round trips the current code makes for that call. Do not change anything yet.

- [ ] **Step 2: Write the failing test**

Create `plugins/p-graph/tools/__tests__/impact-perf.test.ts`. Count the queries instead of timing them — a timing test is flaky, a query count is not:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-perf-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};

describe('the impact frontier scan does not repeat per reached node', () => {
  it('queries once per distinct name, not once per reached symbol', async () => {
    // A chain of 30 callers, so the impact set is large but the number of
    // distinct names to look up stays small.
    let src = 'package chain\nfunc Leaf() {}\n';
    for (let i = 0; i < 30; i++) {
      src += `func Step${i}() { ${i === 0 ? 'Leaf' : `Step${i - 1}`}() }\n`;
    }
    write('chain/chain.go', src);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });
    expect(store.impact('chain.Leaf')).toHaveLength(30);

    // Count the gap-row lookups by wrapping the prepared-statement factory.
    let queries = 0;
    const realPrepare = store.db.prepare.bind(store.db);
    store.db.prepare = (sql) => {
      const stmt = realPrepare(sql);
      if (!/FROM edges/.test(sql)) return stmt;
      const realAll = stmt.all.bind(stmt);
      stmt.all = (...a) => { queries++; return realAll(...a); };
      return stmt;
    };
    store.gapsAround('chain.Leaf');
    // 31 reached symbols would mean ~62 lookups under the old code. One lookup
    // per distinct name is the target; allow a small constant for the no-caller
    // scan.
    expect(queries).toBeLessThan(10);

    store.close();
  }, 30000);
});
```

- [ ] **Step 3: Run the test and watch it fail**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/impact-perf.test.ts
```

Expected: fails with a query count well above 10. Write the real number in your report — it is the size of the regression.

- [ ] **Step 4: Batch the lookup**

In `local-sqlite.mjs`, change `collectGaps` so the name matching runs **one** query with an `IN` list instead of one query per name, and so the no-caller scan runs one query with an `IN` list of node ids instead of one per id. Keep the existing chunking idea for SQLite's bound-parameter limit — chunk at 400 — and keep the dedupe in one place. The row shape, the ordering, the `reason` values and the `reachable` values must not change.

- [ ] **Step 5: Run the test, the suite, and the real repo**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/impact-perf.test.ts
npx vitest run plugins/p-graph
```

Then time the real thing again with the Step 1 command. Report the before and after times and confirm the row count is **identical** — the same rows, faster. A different row count means you changed behaviour, not performance.

- [ ] **Step 6: Commit**

```powershell
git add plugins/p-graph/tools/lib/destinations/local-sqlite.mjs plugins/p-graph/tools/__tests__/impact-perf.test.ts
git commit -m "perf(p-graph): batch the impact frontier scan instead of querying per reached symbol"
```

---

### Task 2: A bare-name query must report the same gaps as a qname query

`callers TestingModule.createNestApplication` reports 184 gap rows. `callers createNestApplication` reports 0. The rows and the gaps disagree about what the user asked for, and the natural way to ask is the one that loses the report.

**Files:**
- Modify: `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs`
- Create: `plugins/p-graph/tools/__tests__/gap-bare-name.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `store.gapsFor` and `store.gapsAround` resolve their argument the same way `store.callers` does — by `id`, `qname`, **or** bare `name`. When a bare name matches several symbols, every one of them contributes its no-caller rows.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-graph/tools/__tests__/gap-bare-name.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-bare-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};

describe('a bare-name query keeps the gap report', () => {
  it('reports the same no-caller rows whether asked by qname or by bare name', async () => {
    // `start` is called at module scope, so the call resolves but has no caller
    // symbol — exactly the row `callers` cannot show and the banner must.
    write('web/engine.ts', 'export class Engine { start() {} }');
    write('web/boot.ts', "import { Engine } from './engine';\nnew Engine().start();");
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    const byQname = store.gapsFor('Engine.start');
    expect(byQname.filter((r) => r.reason === 'no-caller')).toHaveLength(1);

    // `store.callers('start')` finds the symbol by bare name, so the gap report
    // must find it too. Before this fix it returned nothing.
    expect(store.callers('start').length).toBe(store.callers('Engine.start').length);
    const byName = store.gapsFor('start');
    expect(byName.filter((r) => r.reason === 'no-caller')).toHaveLength(1);
    expect(byName.map((r) => `${r.file}:${r.line}`))
      .toEqual(byQname.map((r) => `${r.file}:${r.line}`));

    store.close();
  }, 30000);

  it('collects no-caller rows from every symbol a bare name matches', async () => {
    write('a/a.ts', 'export class A { run() {} }\nnew A().run();');
    write('b/b.ts', 'export class B { run() {} }\nnew B().run();');
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // Both A.run and B.run are called at module scope. Asking by the shared bare
    // name must report both call sites, not one and not none.
    const rows = store.gapsFor('run').filter((r) => r.reason === 'no-caller');
    expect(rows.map((r) => r.file).sort()).toEqual(['a/a.ts', 'b/b.ts']);

    store.close();
  }, 30000);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/gap-bare-name.test.ts
```

Expected: both fail — the first because `gapsFor('start')` returns no `no-caller` row, the second because it returns none at all.

- [ ] **Step 3: Resolve the argument the way `callers` does**

In `local-sqlite.mjs`, replace the single `store.node(name)` lookup inside `gapsFor` / `gapsAround` with a helper that returns **every** matching node:

```js
  // `callers` matches a symbol by id, qname OR bare name, so the gap report has
  // to do the same. Going through store.node() (id or qname only) meant a
  // bare-name query silently dropped the whole no-caller report — 184 rows on a
  // real repo — while the rows above it were still printed.
  const targetsFor = (nameOrId) => db.prepare(
    'SELECT * FROM nodes WHERE id = ? OR qname = ? OR name = ?').all(nameOrId, nameOrId, nameOrId);
```

Use every returned node's `id` for the no-caller scan, and every node's `name` and `qname` for the name matching. Keep the dedupe. When nothing matches, behave exactly as today: match on the raw string alone.

Careful: `reachable` is scored against a package. With several matched symbols, score each row against the package of the symbol whose name matched it — Task 1's batching gives you the row-to-name mapping you need. If a row matched more than one symbol, keep it `reachable: 1`: a possible real miss must not be demoted by an unrelated namesake.

- [ ] **Step 4: Run the test and the suite**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/gap-bare-name.test.ts
npx vitest run plugins/p-graph
```

Expected: green. `store-unresolved.test.ts` asserts `gapsFor('ListGroups')` has 3 rows — a bare name that now also matches nodes. If that count changes, read the new rows before touching the test: more rows may be correct.

- [ ] **Step 5: Commit**

```powershell
git add plugins/p-graph/tools/lib/destinations/local-sqlite.mjs plugins/p-graph/tools/__tests__/gap-bare-name.test.ts
git commit -m "fix(p-graph): keep the gap report when a symbol is asked for by bare name"
```

---

### Task 3: A Go method on a generic type must keep its receiver

`func (p *Partition[K, V]) Clear()` gets the qname `dynacache.Clear` instead of `dynacache.Partition.Clear`. That is 195 of hugo's 4,154 Go methods. It is not only a naming bug: with no `recvType`, `field_key` and `method` are never set, so the guards the previous plan added are satisfied vacuously and the bare-name fallback runs unchecked. This is how the one surviving false builtin edge got through.

Also here: a module path ending in `/vN` gives the wrong package name.

**Files:**
- Modify: `plugins/p-graph/tools/lib/parse/lang/go.scm`
- Modify: `plugins/p-graph/tools/lib/parse/driver.mjs` (`goContext`)
- Modify: `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs` (`SCHEMA_VERSION` only)
- Create: `plugins/p-graph/tools/__tests__/go-generic-receiver.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a method whose receiver is a generic type gets qname `<pkg>.<Type>.<Method>` and a `recvType` of `<pkg>.<Type>`, so every existing guard applies to it. `goContext`'s `importPkgs` maps a `/vN` path to the segment before the version. `SCHEMA_VERSION` is 7 — qnames change, so every existing graph must rebuild.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-graph/tools/__tests__/go-generic-receiver.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-gen-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};

describe('Go generic receivers', () => {
  it('qualifies a method on a generic type with its receiver type', async () => {
    write('cache/cache.go', `package cache
type Partition[K comparable, V any] struct{}
func (p *Partition[K, V]) Clear() {}
func (p Partition[K, V]) Len() int { return 0 }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    expect(store.node('cache.Partition.Clear')).toBeTruthy();
    expect(store.node('cache.Partition.Len')).toBeTruthy();
    expect(store.node('cache.Clear')).toBeNull();

    store.close();
  }, 30000);

  it('does not let a generic receiver collide with a plain one', async () => {
    write('main.go', `package main
type Store[T any] struct{}
func (s *Store[T]) Add(v T) {}
type Plain struct{}
func (p *Plain) Add(v int) {}
func use(s *Store[int]) { s.Add(1) }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // Two distinct methods, two distinct qnames.
    expect(store.node('main.Store.Add')).toBeTruthy();
    expect(store.node('main.Plain.Add')).toBeTruthy();
    // The call is on a parameter, which Task 4 types. Here we only require that
    // it is NOT wrongly attributed to Plain.
    expect(store.callers('main.Plain.Add')).toEqual([]);

    store.close();
  }, 30000);

  it('reads the package name from a versioned module path', async () => {
    write('internal/caddy/dur.go', `package caddy
type Duration int64
func ParseDuration(s string) Duration { return 0 }
`);
    write('modules/proxy/proxy.go', `package proxy
import "github.com/caddyserver/caddy/v2/internal/caddy"
func Setup(s string) caddy.Duration { return caddy.ParseDuration(s) }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // Before the fix the import registered the package as "v2", so this call
    // degraded to the bare name "ParseDuration".
    expect(store.callers('caddy.ParseDuration').map((n) => n.qname)).toEqual(['proxy.Setup']);

    store.close();
  }, 30000);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/go-generic-receiver.test.ts
```

Expected: the first test fails because `cache.Partition.Clear` is null and `cache.Clear` exists; the third fails because the aliased-by-version import is not recognised.

- [ ] **Step 3: Capture a generic receiver**

In `plugins/p-graph/tools/lib/parse/lang/go.scm`, the receiver rules today match only a plain or pointer `type_identifier`:

```
(method_declaration receiver: (parameter_list (parameter_declaration type: (pointer_type (type_identifier) @receiver))))
(method_declaration receiver: (parameter_list (parameter_declaration type: (type_identifier) @receiver)))
```

A generic receiver is a `generic_type` whose first named child is the `type_identifier`. Add two rules that capture that inner identifier, keeping the same `@receiver` capture name so the driver needs no change:

```
; A receiver on a generic type: `func (p *Partition[K, V]) …`. The type name sits
; inside a generic_type, so the plain rules above miss it — and a method with no
; receiver capture loses BOTH its qname qualification and the recvType that every
; resolver guard is keyed on.
(method_declaration receiver: (parameter_list (parameter_declaration
  type: (pointer_type (generic_type (type_identifier) @receiver)))))
(method_declaration receiver: (parameter_list (parameter_declaration
  type: (generic_type (type_identifier) @receiver))))
```

Verify the node names against the vendored grammar before trusting them:

```powershell
node --input-type=module -e "import {loadLanguage, parseAndQuery} from 'file:///C:/projects/perky.team/claude-plugin/plugins/p-graph/tools/lib/parse/engine.mjs'; const l = await loadLanguage('go'); const caps = await parseAndQuery(l, '(method_declaration) @m', 'package p\ntype S[T any] struct{}\nfunc (s *S[T]) M() {}\n'); console.log(caps[0].node.toString());"
```

If the grammar calls it something else, use the real name and say so in your report.

- [ ] **Step 4: Strip a version suffix from an import path**

In `driver.mjs`, `goContext` derives a package name with `path.split('/').pop()`. A Go module path may end in `/v2`, `/v3` and so on, and the package name is then the segment **before** it:

```js
    // A module path may end in a major-version segment (`…/caddy/v2`). The
    // package is named by the segment before it, so taking the last segment
    // registers a package called "v2" — after which no call through that import
    // resolves, and the gap report's reachability check can never match either.
    const parts = path.split('/').filter(Boolean);
    let seg = parts.pop();
    if (/^v[0-9]+$/.test(seg) && parts.length) seg = parts.pop();
```

- [ ] **Step 5: Bump the schema once, and add every column this plan needs**

Method qnames change, so every existing graph must rebuild. **Add both new columns here, in the same bump** — `guess`, which Task 5 populates, and `member`, which Task 6 populates. `CREATE TABLE IF NOT EXISTS` never adds a column to a table that already exists, so a column introduced in a later task without a further bump would be missing on a database that already migrated to 7, and every prepared statement naming it would fail at open. That exact bug shipped once before.

In `local-sqlite.mjs`, extend the `edges` DDL:

```js
CREATE TABLE IF NOT EXISTS edges (
  src_id TEXT, dst_id TEXT, dst_name TEXT, kind TEXT, file TEXT, line INTEGER,
  field_key TEXT, method TEXT, dst_bare TEXT, lang TEXT, external INTEGER DEFAULT 0,
  guess INTEGER DEFAULT 0, member INTEGER DEFAULT 0
);
```

and bump the version:

```js
// 7: a Go method on a generic type is now receiver-qualified (`cache.Partition.Clear`,
// previously `cache.Clear`), and an import path ending in `/vN` now registers the
// right package name. Both change stored qnames and dst_name values, so an older
// graph must be rebuilt rather than patched. This bump also adds edges.guess (set
// when a target was found only by a unique bare name) and edges.member (set when
// the call was written as a member access) — later tasks fill them, and a column
// added after this bump would be missing on an already-migrated graph.
export const SCHEMA_VERSION = 7;
```

Do not populate either column in this task. A test that asserts the columns exist and default to `0` is enough here.

- [ ] **Step 6: Run the test and the suite**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/go-generic-receiver.test.ts
npx vitest run plugins/p-graph
```

Expected: green. If `lang-go.test.ts` or `go-resolution.test.ts` fail, read the failure — a receiver that used to be missing now exists, which may change a qname a test asserts.

- [ ] **Step 7: Check the effect on a real repo**

Index a hugo clone and count the methods that were losing their receiver:

```bash
node --input-type=module -e "
import {openStore} from 'file:///C:/projects/perky.team/claude-plugin/plugins/p-graph/tools/lib/destinations/local-sqlite.mjs';
const s = openStore('.pgraph/graph.db', {readOnly: true});
console.log('methods:', s.db.prepare(\"SELECT count(*) c FROM nodes WHERE kind='method' AND lang='go'\").get().c);
console.log('unqualified:', s.db.prepare(\"SELECT count(*) c FROM nodes WHERE kind='method' AND lang='go' AND qname NOT LIKE '%.%.%'\").get().c);
s.close();"
```

Report both numbers. The reference before this task: 195 of 4,154 hugo Go methods were unqualified.

- [ ] **Step 8: Commit**

```powershell
git add plugins/p-graph/tools/lib/parse/lang/go.scm plugins/p-graph/tools/lib/parse/driver.mjs plugins/p-graph/tools/lib/destinations/local-sqlite.mjs plugins/p-graph/tools/__tests__/go-generic-receiver.test.ts
git commit -m "fix(p-graph): keep the receiver on a Go generic method and read /vN module paths"
```

---

### Task 4: Type a Go parameter and a local variable

This is the task the plan exists for. Every false edge the evaluations hand-checked has the same shape: a call on something whose type p-graph never recorded. `sync.Pool.Put`, `reflect.Value.Index`, `strings.Builder.WriteRune`, `bytes.Buffer.Bytes`, `testing.T.Errorf` — all parameters or locals, all matched by bare name.

**The design reuses the machinery that already works.** p-graph types one receiver shape today: a struct field of the enclosing method's receiver. Extraction records `<struct qname>.<field>` to a type in `field_types`; `resolvePending`'s Pass F resolves `<type>.<method>`, and Pass B refuses the bare-name fallback when the type is known but is not a repo type. Feed that same table two new key shapes and the same guards apply with **no new resolver code**.

**Files:**
- Modify: `plugins/p-graph/tools/lib/parse/lang/go.scm`
- Modify: `plugins/p-graph/tools/lib/parse/driver.mjs`
- Create: `plugins/p-graph/tools/__tests__/receiver-types.test.ts`

**Interfaces:**
- Consumes: `recvType` from Task 3 (a generic receiver now has one), and the existing `field_types` table plus Pass F and Pass B from the previous plan.
- Produces: `field_types` gains rows keyed `"<enclosing def qname>#var:<name>"` whose `type` is the package-qualified type of a parameter, a `var` declaration, or a short variable declaration from a composite literal or `new(T)`. A call `x.M()` where `x` is such a variable records `field_key = "<enclosing def qname>#var:x"` and `method = "M"`, exactly like a field call.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-graph/tools/__tests__/receiver-types.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-recv-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};
async function indexed() {
  const store = openStore(':memory:');
  await indexFull({ root: dir, store, ignorePatterns: [] });
  return store;
}

describe('Go parameter and variable types', () => {
  it('resolves a call on a parameter to that parameter type', async () => {
    write('store/pg.go', `package store
type Postgres struct{}
func (p *Postgres) Get(id string) string { return "" }
type Memory struct{}
func (m *Memory) Get(id string) string { return "" }
`);
    write('api/api.go', `package api
import "x/store"
func Read(db *store.Postgres) string { return db.Get("1") }
`);
    const store = await indexed();

    // Two types have Get, so before this task the call was an unresolved gap.
    expect(store.callers('store.Postgres.Get').map((n) => n.qname)).toEqual(['api.Read']);
    expect(store.callers('store.Memory.Get')).toEqual([]);

    store.close();
  }, 30000);

  it('refuses a call on a parameter whose type lives outside the repo', async () => {
    write('logs/logs.go', `package logs
type Adapter struct{}
func (a *Adapter) Errorf(f string, v ...any) {}
`);
    write('far/far_test.go', `package far
import "testing"
func TestA(t *testing.T) { t.Errorf("boom") }
`);
    const store = await indexed();

    // testing.T is not a repo type, so this call leaves the repo. Linking it to
    // the one repo method named Errorf is the false edge this task removes.
    expect(store.callers('logs.Adapter.Errorf')).toEqual([]);
    // And it must not vanish in silence.
    expect(store.gapsFor('logs.Adapter.Errorf').length).toBeGreaterThan(0);

    store.close();
  }, 30000);

  it('types a local variable declared with var or built from a composite literal', async () => {
    write('store/pg.go', `package store
type Postgres struct{}
func (p *Postgres) Get(id string) string { return "" }
type Memory struct{}
func (m *Memory) Get(id string) string { return "" }
`);
    write('api/api.go', `package api
import "x/store"
func FromVar() string {
	var db store.Postgres
	return db.Get("1")
}
func FromLiteral() string {
	db := &store.Postgres{}
	return db.Get("1")
}
func FromNew() string {
	db := new(store.Memory)
	return db.Get("1")
}
`);
    const store = await indexed();

    expect(store.callers('store.Postgres.Get').map((n) => n.qname).sort())
      .toEqual(['api.FromLiteral', 'api.FromVar']);
    expect(store.callers('store.Memory.Get').map((n) => n.qname)).toEqual(['api.FromNew']);

    store.close();
  }, 30000);

  it('refuses a local whose type it cannot see, and says so', async () => {
    write('io2/io2.go', `package io2
type Counter struct{}
func (c *Counter) WriteRune(r rune) {}
`);
    write('use/use.go', `package use
import "strings"
func Build() string {
	var sb strings.Builder
	sb.WriteRune('x')
	return sb.String()
}
`);
    const store = await indexed();

    expect(store.callers('io2.Counter.WriteRune')).toEqual([]);
    expect(store.gapsFor('io2.Counter.WriteRune').length).toBeGreaterThan(0);

    store.close();
  }, 30000);

  it('leaves a variable it cannot type alone rather than guessing', async () => {
    write('svc/svc.go', `package svc
type A struct{}
func (a *A) Run() {}
func Make() *A { return &A{} }
func Use() {
	x := Make()
	x.Run()
}
`);
    const store = await indexed();

    // The type comes from a function's return value, which this task does not
    // read. The bare name Run is unique here, so the old fallback still links it
    // — that is allowed. What must NOT happen is a wrong link.
    const callers = store.callers('svc.A.Run').map((n) => n.qname);
    expect(callers.every((q) => q === 'svc.Use')).toBe(true);

    store.close();
  }, 30000);

  it('refuses a variable that is assigned two different types', async () => {
    write('svc/svc.go', `package svc
type A struct{}
func (a *A) Run() {}
type B struct{}
func (b *B) Run() {}
func Use(flag bool) {
	var x *A
	y := &B{}
	if flag { x.Run() } else { y.Run() }
}
`);
    const store = await indexed();

    expect(store.callers('svc.A.Run').map((n) => n.qname)).toEqual(['svc.Use']);
    expect(store.callers('svc.B.Run').map((n) => n.qname)).toEqual(['svc.Use']);

    store.close();
  }, 30000);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/receiver-types.test.ts
```

Expected: the first four fail. Quote each real failure in your report — the second and fourth are the false edges this plan exists to remove, so their "before" output is the evidence.

- [ ] **Step 3: Capture the declarations**

Add to `plugins/p-graph/tools/lib/parse/lang/go.scm`:

```
; Declared types of things a call can be made on. A call like `db.Get(...)` can
; only be resolved if we know what `db` is, and for a parameter or a var the
; source says so outright. Without these the resolver falls back to matching the
; bare method name, which is how a sync.Pool.Put became a caller of a repo method.
(parameter_declaration name: (identifier) @var.name type: (_) @var.type)
(var_spec name: (identifier) @var.name type: (_) @var.type)
(short_var_declaration
  left: (expression_list (identifier) @var.name)
  right: (expression_list (composite_literal type: (_) @var.type)))
(short_var_declaration
  left: (expression_list (identifier) @var.name)
  right: (expression_list (unary_expression operand: (composite_literal type: (_) @var.type))))
(short_var_declaration
  left: (expression_list (identifier) @var.name)
  right: (expression_list (call_expression
    function: (identifier) @var.new (#eq? @var.new "new")
    arguments: (argument_list (_) @var.type))))
```

Check every rule against the vendored grammar before relying on it, the same way as in Task 3, and correct any node or field name that differs. Report what you had to change.

- [ ] **Step 4: Record the types in the driver**

In `driver.mjs`, after the existing struct-field block, pair each `var.name` capture with the `var.type` capture that shares its declaration, find the innermost enclosing definition, and push a row:

```js
  // Types of parameters and variables, keyed by the definition they live in.
  // `goFieldTypeName` already turns a type node into a package-qualified name and
  // returns null for shapes we do not resolve through (slices, maps, funcs, inline
  // interfaces), so an unnameable type records nothing and keeps the old
  // behaviour. Two rows for one key mean the variable holds more than one type,
  // and the existing "exactly one known type" guard then refuses it.
  const varNameCaps = caps.filter((c) => c.name === 'var.name');
  const varTypeCaps = caps.filter((c) => c.name === 'var.type');
  for (const nameCap of varNameCaps) {
    const decl = nameCap.node?.parent;
    const typeCap = varTypeCaps.find((t) => t.node?.parent === decl ||
      (decl && within(t, { startLine: decl.startPosition.row + 1, ... })));
    // NOTE for the implementer: match a name to its type by walking up from the
    // name capture to its declaration node and then reading the declaration's own
    // `type` field, rather than by position. Positional matching breaks on
    // `a, b T` and on nested declarations. Use childForFieldName('type').
    ...
  }
```

That sketch is deliberately incomplete on one point, and you must settle it: **pair a name with its type through the AST, not by position.** From a `var.name` capture, walk to its parent declaration node and read that node's `type` field (for a `short_var_declaration`, read the composite literal's or `new`'s type on the right). A declaration like `a, b *store.Postgres` has two names and one type, and both must get a row. Say in your report how you did it.

Then find the enclosing definition (the same `defs.filter(within).sort()` pattern the field-type block uses) and push:

```js
      fieldTypes.push({ key: `${enclosingDef.qname}#var:${varName}`, type: typeName, file });
```

Finally, in the edges loop, extend the identifier-operand branch of `goCallTarget`'s result handling: when the operand is an identifier that is **not** an imported package and **not** the enclosing receiver, set

```js
        field_key = `${enclosing.qname}#var:${target.recvVar}`;
        method = target.method;
```

and leave `dst_name` as the bare method name. Pass F then resolves `<type>.<method>`; Pass B refuses the bare fallback when the type is known but external. **Check the order:** the variable table must be consulted before the import table, so a local that shadows a package name is typed as the local it is — that also fixes the `config.ToKeywords` mis-qualification the previous plan could only report.

- [ ] **Step 5: Run the test and the suite**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/receiver-types.test.ts
npx vitest run plugins/p-graph
```

Expected: all six green, suite green. Tests that will move and must be read, not edited blindly: `store-unresolved.test.ts` (its fixture calls `st.ListGroups()` on a parameter and `p.ListGroups()` on a local — both now type, so some gaps become resolved rows), `self-receiver-resolution.test.ts` ("leaves a Go call on a non-receiver variable alone" — the parameter is now typed, so the expectation genuinely changes), and `false-edges.test.ts`. For each, decide whether the new behaviour is right before changing the expectation, and record your reasoning.

- [ ] **Step 6: Measure the four symbols that lied**

Index a hugo clone and run the four queries the evaluation used, with `gopls` reference counts as the target:

```bash
node .../pgraph.mjs callers goldmark.idFactory.Put                      # gopls: 0 references
node .../pgraph.mjs callers collections.Namespace.Index                 # gopls: 3
node .../pgraph.mjs callers highlight.byteCountFlexiWriter.WriteRune     # gopls: 1
node .../pgraph.mjs callers bufferpool.GetBuffer                         # gopls: 24
```

Reference before this task: 12 rows, 32 rows, 7 rows, 20 rows. Report the new counts and read enough of each remaining row to say whether it is real. Also report the repo-wide numbers: total resolved Go call edges, how many now resolve through a `#var:` key, and how many still resolve by bare name.

- [ ] **Step 7: Commit**

```powershell
git add plugins/p-graph/tools/lib/parse/lang/go.scm plugins/p-graph/tools/lib/parse/driver.mjs plugins/p-graph/tools/__tests__/receiver-types.test.ts
git commit -m "feat(p-graph): type Go parameters and local variables so a call on them resolves or is refused"
```

---

### Task 5: Mark what is still a guess, and keep it out of `impact`

Task 4 types most receivers. What is left — a variable assigned from a function call, an interface value, a package-level var, a method value — still resolves by unique bare name, which is a guess. A guess is acceptable in a candidate list and unacceptable in a blast radius: 12 false leaf edges produced **713** falsely impacted symbols on hugo.

**Files:**
- Modify: `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs`
- Modify: `plugins/p-graph/tools/lib/cli/commands.mjs`
- Create: `plugins/p-graph/tools/__tests__/confidence.test.ts`

**Interfaces:**
- Consumes: the resolution passes as they stand after Task 4.
- Produces: `edges` gains a column `guess INTEGER DEFAULT 0`, set to `1` by the pass that links a target only because its bare name happened to be unique. `store.callers` and `store.callees` return each row with a `guess` field. `store.impact` walks only edges with `guess = 0`. The CLI prints guessed rows under their own heading.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-graph/tools/__tests__/confidence.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-conf-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};

describe('a guessed edge is marked and kept out of impact', () => {
  it('marks a bare-name link as a guess and a typed link as certain', async () => {
    write('svc/svc.go', `package svc
type A struct{}
func (a *A) Certain() {}
func (a *A) Guessed() {}
func Make() *A { return &A{} }
func UseTyped(a *A) { a.Certain() }
func UseGuessed() {
	x := Make()
	x.Guessed()
}
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    expect(store.callers('svc.A.Certain')[0]).toMatchObject({ qname: 'svc.UseTyped', guess: 0 });
    expect(store.callers('svc.A.Guessed')[0]).toMatchObject({ qname: 'svc.UseGuessed', guess: 1 });

    store.close();
  }, 30000);

  it('does not let a guessed edge seed the impact set', async () => {
    write('pool/pool.go', `package pool
type Factory struct{}
func (f *Factory) Put(v any) {}
`);
    write('app/app.go', `package app
import "sync"
type Deep struct{}
func (d *Deep) Top() { d.mid() }
func (d *Deep) mid() {
	var p sync.Pool
	p.Put(1)
}
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // sync.Pool is typed after Task 4, so nothing links at all here. The point of
    // this test is the walk: even if a guess DID link, it must not drag Top in.
    const impacted = store.impact('pool.Factory.Put').map((n) => n.qname);
    expect(impacted).not.toContain('app.Deep.Top');

    store.close();
  }, 30000);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/confidence.test.ts
```

Expected: the first fails because rows carry no `guess` field.

- [ ] **Step 3: Record the guess**

The `edges.guess` column already exists — Task 3 added it with the schema bump. In `resolvePending`, set `guess = 1` in the bare-name pass (Pass B) and in the own-receiver fallback (Pass C), and `guess = 0` in the exact-qualified pass (Pass A) and the field/variable-type pass (Pass F). Because every call edge is invalidated and re-resolved on each index, clear `guess` at the same time as `dst_id`.

Add `e.guess` to the `SELECT` in `store.callers` and `store.callees`. In `store.impact`, add `AND e.guess = 0` to the recursive step:

```sql
        SELECT e.src_id, up.depth + 1 FROM edges e
        JOIN up ON e.dst_id = up.id
        WHERE up.depth < ${MAX_DEPTH} AND e.src_id IS NOT NULL AND e.guess = 0
```

Do **not** bump `SCHEMA_VERSION` — Task 3 already took it to 7, and that forces the rebuild that creates this column.

- [ ] **Step 4: Print it apart**

In `commands.mjs`, split the `callers` and `callees` row lists into certain rows and guessed rows. Print the certain ones as now; print the guessed ones under one short heading that says why they are uncertain — the graph could not see the receiver's type, so the row may belong to a different symbol with the same method name. Keep the wording plain and short. `impact` gains one line saying guessed edges were not followed. `--json` gains the `guess` field on each row; do not add a flag.

- [ ] **Step 5: Run the test and the suite, then look at the output**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/confidence.test.ts
npx vitest run plugins/p-graph
```

Then run `callers` on a real repo for a symbol with a common method name and paste the output into your report. Judge honestly whether the two groups read clearly, and say so even if every test passes.

- [ ] **Step 6: Commit**

```powershell
git add plugins/p-graph/tools/lib/destinations/local-sqlite.mjs plugins/p-graph/tools/lib/cli/commands.mjs plugins/p-graph/tools/__tests__/confidence.test.ts
git commit -m "feat(p-graph): mark a bare-name link as a guess and stop impact from following one"
```

---

### Task 6: A member call cannot claim a top-level symbol

In TypeScript, JavaScript, Python and C++ a `qname` comes only from lexical nesting. A ten-line arrow function named `end` inside one method body therefore has the qname `end` — and the exact-qualified pass matches it for **all 825** `.end()` calls in got. **95.6% of resolved TypeScript call sites are false**, and the same shape produces 91 false Python edges for `requests.api.get`.

The rule: a call written as a member access (`x.end()`) can only target a symbol that **has an owner**. A symbol whose qname carries no owner cannot be the target of `x.end()`.

**Files:**
- Modify: `plugins/p-graph/tools/lib/parse/driver.mjs`
- Modify: `plugins/p-graph/tools/lib/parse/lang/py.scm`
- Modify: `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs`
- Create: `plugins/p-graph/tools/__tests__/member-call-owner.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `edges` gains a column `member INTEGER DEFAULT 0`, set to `1` when the call was written as a member access rather than a plain identifier. Passes A, B and C require a target with `container_id IS NOT NULL` when `member = 1`. For Python, `goContext`'s idea of an imported module name gets an equivalent: a member call whose object names an imported module is treated as module-qualified, so `requests.get(...)` still resolves while `s.get(...)` does not.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-graph/tools/__tests__/member-call-owner.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-member-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};
async function indexed() {
  const store = openStore(':memory:');
  await indexFull({ root: dir, store, ignorePatterns: [] });
  return store;
}

describe('a member call needs a target with an owner', () => {
  it('does not link every .end() to a local arrow function named end', async () => {
    write('http2.ts', `export class Req {
  _final(cb: () => void): void {
    const end = () => { this.stream.end(cb); };
    end();
  }
}
export function serve(response: any) { response.end('bye'); }
`);
    const store = await indexed();

    // `end` is a local arrow function with no owner. Only the plain `end()` call
    // on the line below it can target it — not `response.end(...)`.
    expect(store.callers('end').length).toBeLessThanOrEqual(1);
    const rows = store.callers('end').map((n) => n.qname);
    expect(rows).not.toContain('serve');

    store.close();
  }, 30000);

  it('still links a member call to a real method', async () => {
    write('repo.ts', `export class UserRepo { get(id: string) { return id; } }
export function read(r: UserRepo) { return r.get('1'); }
`);
    const store = await indexed();

    expect(store.callers('UserRepo.get').map((n) => n.qname)).toEqual(['read']);

    store.close();
  }, 30000);

  it('still links a TypeScript constructor call', async () => {
    write('app.ts', `export class Service { run() {} }
export function boot() { return new Service(); }
`);
    const store = await indexed();

    expect(store.callers('Service').map((n) => n.qname)).toEqual(['boot']);

    store.close();
  }, 30000);

  it('resolves a Python call through an imported module but not through a value', async () => {
    write('api.py', `def get(url):
    return url
`);
    write('client.py', `import api

class Session:
    def get(self, url):
        return url

def fetch(s):
    api.get('http://x')
    s.get('http://y')
`);
    const store = await indexed();

    // api.get is module-qualified, so it resolves. s.get is a call on a value
    // whose type is unknown, so it must not resolve to the module function.
    expect(store.callers('get').map((n) => n.qname)).toEqual(['fetch']);
    expect(store.gapsFor('Session.get').length).toBeGreaterThan(0);

    store.close();
  }, 30000);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/member-call-owner.test.ts
```

Expected: the first fails because `serve` is listed as a caller of the local `end`; the fourth fails on the Python module case.

- [ ] **Step 3: Record whether the call was a member access**

In `driver.mjs`'s edges loop, set `member = 1` when the capture's parent is a member/attribute/field access rather than a plain identifier call. TS/JS use `member_expression`, Python `attribute`, C++ `field_expression`, Go `selector_expression` — Go already qualifies its targets, so leave Go's behaviour unchanged and set the column for it too, for consistency and for the report.

- [ ] **Step 4: Require an owner in the resolver**

The `edges.member` column already exists — Task 3 added it with the schema bump. In `local-sqlite.mjs`, add to Passes A, B and C:

```sql
        AND (edges.member = 0 OR n.container_id IS NOT NULL)
```

A `new Service()` call in TypeScript is a plain identifier call, so it is unaffected and the class node still resolves.

- [ ] **Step 5: Let Python resolve a module-qualified call**

Add an import-name set for Python the way `goContext` has one. `py.scm` already captures `import_statement` and `import_from_statement`; record the module names, and in the driver treat a member call whose object is one of them as module-qualified — record the bare function name as the target and clear `member`, because the object is a module and not a value. State in your report which import forms you cover (`import x`, `import x as y`, `from x import y`) and which you do not.

- [ ] **Step 6: Run the test and the suite**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/member-call-owner.test.ts
npx vitest run plugins/p-graph
```

Expected: green. `lang-ts.test.ts`, `lang-js.test.ts`, `lang-py.test.ts`, `self-receiver-resolution.test.ts` and `false-edges.test.ts` all touch this area — read every failure before editing a test.

- [ ] **Step 7: Measure it on the real repos**

Index sindresorhus/got and pallets/flask and report, before and after: total resolved call edges, and the caller-row counts for `end`, `exec`, `setHeader` (got) and `get`, `RequestsCookieJar.set`, `RequestsCookieJar.update` (flask). Reference before this task: 825 sites linked to `end` of which 1 was real; `get` had 84 real of 175.

- [ ] **Step 8: Commit**

```powershell
git add plugins/p-graph/tools/lib/parse/driver.mjs plugins/p-graph/tools/lib/parse/lang/py.scm plugins/p-graph/tools/lib/destinations/local-sqlite.mjs plugins/p-graph/tools/__tests__/member-call-owner.test.ts
git commit -m "fix(p-graph): stop a member call from claiming a symbol that has no owner"
```

---

### Task 7: Make C++ work, or stop advertising it

On google/leveldb, **260 of 266** out-of-class method definitions are missing, and `callers TotalArea` prints nothing at all — no rows, no banner, exit 0. Silence reads as "no callers", which is the worst possible answer.

**Files:**
- Modify: `plugins/p-graph/tools/lib/parse/lang/cpp.scm`
- Modify: `plugins/p-graph/tools/lib/parse/driver.mjs`
- Create: `plugins/p-graph/tools/__tests__/lang-cpp-outofclass.test.ts`

**Interfaces:**
- Consumes: the `member`/owner rule from Task 6.
- Produces: an out-of-class definition (`std::string PgStore::Get(int)`) is indexed as a method with qname `PgStore.Get`; a header declaration is indexed as a method of its class; a qualified call (`geo::TotalArea(...)`) produces a call edge.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-graph/tools/__tests__/lang-cpp-outofclass.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-cpp-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};

describe('C++ header and implementation split', () => {
  it('indexes an out-of-class method definition and finds its caller', async () => {
    write('include/store.h', `#pragma once
#include <string>
class PgStore {
 public:
  std::string Get(int id);
  void Put(int id, const std::string& v);
};
`);
    write('src/store.cpp', `#include "store.h"
std::string PgStore::Get(int id) { return ""; }
void PgStore::Put(int id, const std::string& v) { Get(id); }
`);
    write('src/main.cpp', `#include "store.h"
int main() {
  PgStore s;
  s.Get(1);
  return 0;
}
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    expect(store.node('PgStore.Get')).toBeTruthy();
    expect(store.node('PgStore.Put')).toBeTruthy();
    expect(store.callers('PgStore.Get').map((n) => n.qname)).toContain('PgStore.Put');

    store.close();
  }, 30000);

  it('creates an edge for a namespace-qualified call', async () => {
    write('src/geo.h', `#pragma once
namespace geo { double TotalArea(const double* a, int n); }
`);
    write('src/geo.cpp', `#include "geo.h"
namespace geo { double TotalArea(const double* a, int n) { return 0; } }
`);
    write('src/main.cpp', `#include "geo.h"
int main() { double a[1] = {1}; return (int)geo::TotalArea(a, 1); }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // Before this task a qualified_identifier call produced no edge at all, so
    // there was nothing for the gap report to show either.
    const edges = store.db.prepare(
      `SELECT count(*) c FROM edges WHERE kind='call' AND dst_bare='TotalArea'`).get().c;
    expect(edges).toBeGreaterThan(0);

    store.close();
  }, 30000);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/lang-cpp-outofclass.test.ts
```

Expected: both fail — no `PgStore.Get` node, and no `TotalArea` call edge.

- [ ] **Step 3: Capture the missing shapes**

`cpp.scm` today matches a `function_definition` whose declarator is an `identifier` or a `field_identifier`. Add rules for:

- an out-of-class definition, whose declarator is a `qualified_identifier` (`PgStore::Get`) — capture the class part and the name part so the driver can build the `Class.Method` qname without relying on lexical nesting;
- a declaration inside a class body (`field_declaration` with a `function_declarator`), so a header-only declaration is a symbol;
- a pointer or reference return type, which wraps the declarator in a `pointer_declarator` or `reference_declarator`;
- a call whose function is a `qualified_identifier`.

Verify every node and field name against the vendored grammar with the `parseAndQuery` snippet pattern from Task 3 before relying on it, and report anything that differs.

In `driver.mjs`, build the qname for an out-of-class definition from the captured class part rather than from the enclosing definition, and treat a namespace-qualified call the way Go treats a package-qualified one.

- [ ] **Step 4: Run the test and the suite**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/lang-cpp-outofclass.test.ts
npx vitest run plugins/p-graph
```

- [ ] **Step 5: Measure on leveldb, and decide**

```bash
cd "$TMPDIR" && git clone --depth 1 https://github.com/google/leveldb leveldb-eval && cd leveldb-eval && mkdir -p .pgraph
node .../pgraph.mjs index --full && node .../pgraph.mjs status
node .../pgraph.mjs callers DBImpl.Get
```

Report the symbol count and how many out-of-class definitions are now indexed. Reference before this task: 1,548 nodes, 260 of 266 out-of-class definitions missing, `callers DBImpl.Get` printing nothing.

**If this task does not get C++ to a usable state, say so and stop.** Then Task 10 removes C++ from the plugin's advertised languages instead of leaving a silent wrong answer in place. That is a legitimate outcome of this task, not a failure.

- [ ] **Step 6: Commit**

```powershell
git add plugins/p-graph/tools/lib/parse/lang/cpp.scm plugins/p-graph/tools/lib/parse/driver.mjs plugins/p-graph/tools/__tests__/lang-cpp-outofclass.test.ts
git commit -m "fix(p-graph): index C++ out-of-class definitions and qualified calls"
```

---

### Task 8: Four small things that waste space, lie about drift, or break a supported setup

**Files:**
- Modify: `plugins/p-graph/tools/lib/parse/driver.mjs` (signature length)
- Modify: `plugins/p-graph/tools/lib/cli/commands.mjs` (drift)
- Modify: `plugins/p-graph/tools/lib/index/build.mjs` and `plugins/p-graph/tools/lib/freshness.mjs` (git stderr)
- Modify: `plugins/p-graph/tools/pgraph.mjs` (read-only directory, double prefix)
- Modify: existing test files as needed

**Interfaces:**
- Consumes: nothing.
- Produces: `nodes.signature` is capped at 300 characters. `status`'s drift counts only files the index would read. No `git` invocation leaks stderr to the terminal. A read-only `.pgraph` directory degrades to a working read-only query instead of failing every command.

- [ ] **Step 1: Cap the stored signature**

caddy's graph is 105.6 MB for 326 files, and 44.8 MB of that is `signature` — whole source lines, the longest **157,787 characters** from a bundled JavaScript file. Write a test that indexes a file with a 5,000-character line and asserts the stored signature is at most 300 characters and ends with a marker. Then cap it in `driver.mjs`. Report the new database size for caddy.

- [ ] **Step 2: Count drift the way the refresh does**

`freshness.mjs` already has `computeActionable`, whose own comment says raw git output "would make an uncommitted README.md edit look like perpetual drift" — and `status` in `commands.mjs` does exactly that. Every corpus in the evaluation read `drift 1` right after a full index, because of its own untracked `.pgraph/`. Write a test: index a tree, add a `README.md` edit and an untracked `.txt`, assert `status` reports `drift 0`. Then route `status` through the same filter the refresh uses.

- [ ] **Step 3: Stop git's stderr from leaking**

In a non-git tree every command prints `fatal: not a git repository (or any of the parent directories): .git`, including `index` and `status`, and it pollutes the project's own test output. Pass `stdio: ['ignore', 'pipe', 'ignore']` (or the equivalent) to every `execFileSync` git call in `build.mjs` and `freshness.mjs`. p-graph's own `⚠ p-graph STALE: cannot verify freshness` line already tells the user what matters. Write a test asserting stderr contains no `fatal:` line in a non-git tree.

- [ ] **Step 4: Survive a read-only `.pgraph` directory**

A read-only **file** works today. A read-only **directory** fails every command with `pgraph: unable to open database file`, because WAL mode must create a `-shm` file even to read. The read-only fallback in `pgraph.mjs` exists for exactly this case and cannot do its job. Open the fallback in a mode that does not need to write beside the database — SQLite's `immutable` or a `journal_mode` that needs no side files — and fix the double prefix in `pgraph: p-graph: store is read-only`. Write a test that makes the directory read-only, runs `callers`, and asserts a correct answer. If the platform makes this untestable, say so plainly and test what you can.

- [ ] **Step 5: Run the suite and commit**

```powershell
npx vitest run plugins/p-graph
git add plugins/p-graph/tools
git commit -m "fix(p-graph): cap stored signatures, count drift like the refresh does, hide git stderr, survive a read-only .pgraph"
```

---

### Task 9: Re-measure everything, on five repositories

**Files:**
- Create: `plugins/p-graph/docs/superpowers/plans/2026-08-01-p-graph-correct-answers-results.md`

**Interfaces:**
- Consumes: Tasks 1 to 8.
- Produces: a results document. No code change.

- [ ] **Step 1: Index all five corpora and record the totals**

`gohugoio/hugo`, `nestjs/nest`, `pallets/flask`, `caddyserver/caddy`, `google/leveldb`, each `git clone --depth 1`, outside the project tree. For each: files, nodes, call edges, resolved, unattributed, guessed, index time, database size. The before numbers to compare against:

| Corpus | Files | Nodes | Call edges | Resolved | Unattributed | Index | DB |
|---|---|---|---|---|---|---|---|
| hugo | 928 | 9,882 | 55,402 | 16,232 | 39,170 | 24.9 s | 70.4 MB |
| nest | 1,727 | 5,775 | 38,153 | 9,592 | 28,561 | 45.0 s | 15.0 MB |
| flask | 83 | 1,619 | 3,905 | 1,513 | 2,392 | 1.2 s | 1.8 MB |
| caddy | 326 | 3,553 | 23,510 | 7,320 | 16,190 | 12.2 s | 105.6 MB |
| leveldb | 132 | 1,548 | 8,368 | 3,131 | 5,237 | 5.1 s | 2.6 MB |

- [ ] **Step 2: Re-run the queries that were wrong**

With `gopls` reference counts as ground truth on hugo:

| Symbol | gopls | before |
|---|---|---|
| `goldmark.idFactory.Put` | 0 | 12 rows |
| `collections.Namespace.Index` | 3 | 32 rows |
| `highlight.byteCountFlexiWriter.WriteRune` | 1 | 7 rows |
| `bufferpool.GetBuffer` | 24 | 20 rows, 24 of 24 sites |

And on got and flask: `end` (825 sites linked, 1 real), `exec`, `setHeader`, `get` (84 real of 175), `RequestsCookieJar.set`, `RequestsCookieJar.update`.

Read enough rows to say whether each remaining one is real. Report certain rows and guessed rows separately, since Task 5 splits them.

- [ ] **Step 3: Hand-check precision again, and target the hard class**

Two samples. A uniform random sample of 25 resolved Go edges, and a sample of 15 from the class the last evaluation found 47% wrong — a bare-name resolution into a method of a package the calling file neither belongs to nor imports. Report both fractions. The point of the second sample is that false edges are not spread evenly, so a uniform sample hides them.

- [ ] **Step 4: Confirm the two regressions are gone**

Time `impact` on hugo and caddy (before: 15,555 ms and 2,373 ms). Run `callers` by bare name and by qname on nest's `createNestApplication` and confirm the gap counts now match.

- [ ] **Step 5: Re-run the grep agreement measurement**

Repeat the earlier acceptance test on at least 15 symbols across the three languages: for every real call site grep finds, is it **found**, **flagged**, **counted** or **silent**, and for every resolved row, is it real? The previous result was 0 silent out of 2,438 and 32.5% of resolved sites false. Both numbers must be reported again. **A rise in silent misses is a stop-the-line finding** — this plan trades some resolution for correctness, and anything it stops resolving must show up in the gap report instead.

- [ ] **Step 6: Write the results document and commit**

Include every number, every symbol, the two precision fractions, the timings, the grep agreement rates, and an explicit list of what still is not fixed.

```powershell
git add plugins/p-graph/docs/superpowers/plans/2026-08-01-p-graph-correct-answers-results.md
git commit -m "docs(p-graph): record the measured before/after for the correct-answers work"
```

---

### Task 10: Documentation that matches the new behaviour

**Files:**
- Modify: `plugins/p-graph/README.md`
- Modify: `plugins/p-graph/skills/query/SKILL.md`
- Modify: `plugins/p-graph/skills/help/SKILL.md`
- Modify: `plugins/p-graph/skills/_shared/templates/p-graph-rule.template.md`

**Interfaces:**
- Consumes: the behaviour from Tasks 1 to 8 and the numbers from Task 9.
- Produces: no code interface.

- [ ] **Step 1: Read the code, then write**

Every earlier documentation pass on this plugin shipped a claim the code did not support, and each was caught by review. Read `resolvePending`, `gapsFor`/`gapsFrom`/`gapsAround`, and `emitGaps` before writing a sentence, and quote every banner line character for character from the code.

- [ ] **Step 2: Describe what a row now means**

The README's "Name resolution" section must say: a row is **certain** when the target came from a qualified name or from a recorded type (a receiver, a struct field, a parameter, a variable); a row is a **guess** when it came from a unique bare name, is printed under its own heading, and is not followed by `impact`. Replace the precision figures with Task 9's fresh numbers, naming the corpus and commit.

- [ ] **Step 3: Update the two things a Claude instance reads**

`skills/query/SKILL.md` and the rule template must say: relay the gap banner; treat a guessed row as a lead and check it; `impact` follows certain edges only, so its answer is a floor, not a ceiling. Keep it short — these are instructions, not prose.

- [ ] **Step 4: Tell the truth about C++**

If Task 7 got C++ to a usable state, say what it now indexes and what it still misses. If it did not, remove C++ from the supported-languages table and from `plugin.json`'s description at release time, and say plainly in the README that C++ files are parsed for `#include` edges only.

- [ ] **Step 5: Verify and commit**

```powershell
npx vitest run tests/plugin-manifests.test.ts
npm run validate
npx vitest run plugins/p-graph
```

```powershell
git add plugins/p-graph/README.md plugins/p-graph/skills
git commit -m "docs(p-graph): describe certain rows, guessed rows, and what impact follows"
```

---

## Release note (do not perform as part of this plan)

After Task 10, the release procedure in `.claude/CLAUDE.md` applies. Expected: `p-graph` `0.7.1 → 0.9.0` (minor — new resolution behaviour, new `--json` fields, no removed commands), or `1.0.0` if the `--json` shape is treated as a public contract. `SCHEMA_VERSION` 7 forces one automatic full reindex for every existing user. **`plugin.json#version` has not been bumped for the previous plan's work either — without a bump the marketplace cache keeps the old code, so both plans must ship under one version bump.**

## Still not fixed after this plan

1. **Interface dispatch.** No `implements` edges. A call through an interface with one implementation resolves to it as a guess; with two or more it becomes a gap. The honest answer is "these N types could receive this call", and that needs its own plan.
2. **TypeScript call-argument function bodies.** `describe`/`it` callbacks are not definitions, so 394 of nest's 1,727 files produce no symbols and 56% of resolved edges have no source symbol. They surface in the gap report as `outside any indexed symbol`, but they have no caller.
3. **A variable typed from a function's return value.** `x := Make()` needs the return type of `Make`, which means reading signatures across files. Task 5 marks these as guesses instead.
4. **A method value.** `h := m.Send; h("bye")` records a call to `h`, and no name matching can recover the target.
5. **Two repo packages sharing a base name.** `a/config` and `b/config` both declare `package config` and collapse into one qname namespace, so a call can resolve to the wrong package's symbol.
6. **A file created and deleted without ever being committed** leaves a stale row until the next `--full`, because `gitChangedFiles` cannot see it.
