# A call written at file scope gets a caller — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List a call written outside any function in the answer's main list, grouped
by the file that holds it, instead of one line at a time in the gap banner where a
20-row cap can hide it.

**Architecture:** Synthesize the rows in the read path. Do **not** add a file node to
the graph — the reason is measured and it is in "Why not a file node" below. Then stop
reporting those calls as gaps, because they are no longer missing.

**Tech Stack:** Node 24+ for the suite (22.5+ for the plugin), `node:sqlite`. No npm
dependencies. No schema change.

## Global Constraints

- **No new npm dependency.** p-graph ships with `node:sqlite` and vendored grammars.
- **No `SCHEMA_VERSION` bump.** Nothing about stored rows changes; this is all read
  path. If you find yourself needing a bump, stop and report — the design is wrong.
- **Every test run happens under WSL, and the whole suite** (see `.claude/CLAUDE.md`).
  Baseline at the branch point: 291 files passed / 2 skipped, 2,845 tests passed / 14
  skipped, exit 0.
- **Comments explain WHY with the measured number**, in Simple English, matching the
  voice of the comments already in these files.
- **`--json` and the text output must agree.** They come from the same store call, and
  a consumer reading `callers` from JSON must see the same rows a reader sees.
- **`✓ complete` must stay honest.** It is the strongest claim this plugin makes: the
  rule reads it as "stop. Do not grep." An answer may only earn it when nothing is
  missing.

---

## What was measured

> Everything down to "What it buys on the study's worst question" is the analysis done
> **before** any code was written. The `>` callouts at the end of the section record
> what the finished branch actually printed, and where the analysis was wrong. Read
> those before quoting a number from here.

A call written outside any function — `axios.interceptors.request.eject(id)` at the top
of a module, a Go package-level `var x = pkg.New()`, a nest `@Injectable()` on a class —
has no enclosing symbol, so its edge carries `src_id = NULL`. `store.callers` inner-joins
on `src_id`, so no such row can be in the main list.

Counted over the study's clones, `ts`/`js`/`go`/`py` call edges, `external = 0`:

| Repo | call edges | no caller | share | resolved, so a real call site |
|---|---:|---:|---:|---:|
| axios | 11,290 | 898 | 8.0% | 94 |
| nest | 34,991 | 1,260 | 3.6% | 450 |
| got | 12,891 | 1,456 | 11.3% | 16 |
| flask | 3,491 | 226 | 6.5% | 30 |
| requests | 2,274 | 88 | 3.9% | 13 |
| hugo | 50,261 | 4,504 | 9.0% | **1,826** |

hugo is Go, so this is not a TypeScript problem.

### These rows are not lost — that claim was wrong

An earlier note on this work said the 2,429 resolved rows "can never appear in an
answer". They did appear. `collectGaps` had a reason for exactly this shape —
`'no-caller' — a RESOLVED call to the target made outside any indexed symbol` — and it
printed in the `⚠` banner of `callers`, `callees`, `impact` and `context`. This is the
output from **before** the branch; no command prints that phrase any more:

```
$ pgraph callers InterceptorManager.eject
… 17 call sites in the main list …
⚠ 8 call sites missing from this answer:
    tests/module/esm/tests/helpers/esm-index.ts:344  outside any indexed symbol -> eject
    …
```

So the real problem is narrower and it is about cost, not loss.

### The banner is capped at 20 rows, and the cap bites

`GAP_LIMIT = 20` in `tools/lib/cli/commands.mjs`. Above it the banner prints
`… and N more` and names nothing. Counted per symbol:

| Repo | symbols with file-scope callers | over the cap | rows never named | worst symbol |
|---|---:|---:|---:|---|
| axios | 38 | 1 | 4 | `InterceptorManager.use` 24 |
| nest | 34 | 3 | **286** | `Injectable` 199 |
| got | 11 | 0 | 0 | — |
| hugo | 189 | 9 | **1,210** | `i` 647 |

So **13 symbols across four repos hide 1,500 call sites behind the cap.** Measured
directly on hugo's `parse.mkItem`: 120 file-scope call sites, 20 named, `… and 100 more`.

The cap is right, by the way — its comment says a banner nobody reads is worse than
none, and this study has measured a long banner costing what having no graph costs.
The fix is not to raise it. The fix is to stop putting these rows there.

### And under the cap they still cost the reader more than they should

A row in the main list is grouped by its caller and reads as one line for several call
sites. A row in the banner is one line each, and `p-graph-rule.template.md` makes the
reader judge each one. Grouped by file, the eight axios rows are two lines:

```
file tests/module/cjs/tests/helpers/cjs-typing.ts  316, 333, 357, 358
file tests/module/esm/tests/helpers/esm-index.ts   344, 359, 383, 384
```

That is the whole change: same facts, listed instead of bannered.

### What it buys on the study's worst question

`axios-eject` is p-graph's worst question in the four-language study, 51 of 75. With
this plan it goes from *17 listed + 8 bannered + `⚠`* to *25 listed + `✓ complete`* —
and `✓ complete` is then true, which it was not before this branch started.

> **The count landed. The strength did not: 14 of axios's 25 call sites are guesses,
> and all 8 on the new file rows are among them.** The line above reads as 25 settled
> call sites. Measured after the code landed, on the study's own axios clone,
> `callers InterceptorManager.eject --json`:
>
> | | rows | call sites |
> |---|---:|---:|
> | caller rows, certain | 6 | 11 |
> | caller rows, guessed | 5 | 6 |
> | **file rows, certain** | **0** | **0** |
> | **file rows, guessed** | **2** | **8** |
> | total | 13 | **25** |
>
> `gaps: []` and `complete: true`, so the banner is empty and `✓ complete` prints. All
> 25 call sites are in the list, but only 11 are settled — both axios file rows land
> under `UNVERIFIED: 7 more callers, matched by name only (guess)`. Nothing lied: the
> guess heading sits right above the rows, and `✓ complete` claims that nothing is
> *missing*, not that everything is certain. But a reader of this plan would have
> expected 25 plain rows, so the rule now spells out the difference.
>
> The other two symbols came out as predicted, and hugo's came out stronger:
>
> | symbol | before | after |
> |---|---|---|
> | hugo `parse.mkItem` | 2 caller rows, 11 sites; 20 of its 120 file-scope sites named in the banner, then `… and 100 more`, then `⚠` | + 1 **certain** file row carrying all 120 lines — 131 sites, empty banner, `✓ complete` |
> | nest `Injectable` | 152 caller rows; 199 file-scope sites in the banner plus 1 unresolved one, 20 named, the rest behind `… and N more` | + 196 **certain** file rows carrying all 199 sites; 1 gap row left, `⚠ 1 call site missing` |
> | axios `InterceptorManager.eject` | 17 listed, 8 in the banner, `⚠` | 25 listed (11 certain, 14 guessed), empty banner, `✓ complete` |
>
> nest's one remaining gap is a real unresolved call at file scope, in
> `sample/09-babel-example/src/cats/cats.service.js:3`. The banner labels it
> `file scope` — the middle column falls back to that when a gap row has no enclosing
> symbol — so `⚠ 1 call site missing` there is honest, and `complete: false` is right.
>
> **"Rows named nowhere" is 0 by construction, not by luck.** `collectGaps` produces a
> `no-caller` row only inside `if (callerCheckIds.length)`, and both of its callers —
> `gapsFor` (callers, context) and `gapsAround` (impact) — now pass an empty list. A
> file-scope call can therefore never reach a gap list, so the `… and N more` tail can
> never hide one. The 1,500 counted above is 0.
>
> The six-repo table further up counts 2,429 resolved file-scope calls; the ten-clone
> figure quoted below is 4,998. Those are different repo sets, not a correction.

> **Task 2 was not a rendering fix, and `impact` needed a task this plan does not
> have.** Three corrections to the plan's own shape, all found while executing it.
>
> - **The CLI already rendered a file row, and rendered it correctly.** `fmtSites`
>   falls back to `${n.file}:${n.start_line}` only when `call_sites` is EMPTY, and a
>   file row's site list is never empty — so the line already printed as
>   `file app/boot.js  app/boot.js:3, 4`, with no crash and no `:null`. Task 2 shrank to
>   one thing: stop printing the path twice. `fmtSites` now seeds its "a repeated file
>   is written once" rule with the row's own path, so the line reads
>   `file app/boot.js  3, 4`. That is one formatter line and does not earn its own
>   review round, so tasks 2 and 3 were dispatched together (commits `fe8115c`,
>   `724e5d8`).
> - **`impact` needed its own task** (commit `a63cf45`). `store.impact` walks
>   `src_id IS NOT NULL`, so it could not carry a file-scope call either. Once tasks 2
>   and 3 landed, `impact Manager.eject` printed `(no impact)` and then named the two
>   call sites under `⚠`: the headline was false, the banner rescued it, and `callers`
>   on the same symbol already listed them — the two commands disagreed about one
>   symbol. A call at file scope really does break when the target changes, so `impact`
>   now carries it as a **leaf**: nothing calls a top-level statement, so it ends the
>   chain instead of extending it.
> - **`impact` lists only the file-scope calls it is certain of.** A guessed one would
>   sit in a flat list with nothing to mark it, directly under `✓ complete`, so it goes
>   into `skipped_guesses` instead — and a non-zero `skipped_guesses` blocks
>   `✓ complete`. Measured across ten clones: 4,672 of 4,998 resolved file-scope calls
>   (93%) are certain and move into the list; 326 are guesses and move into the count.

## Why not a file node

The obvious design is a node per file that owns its top-level calls. It is wrong here,
and the reason is in the driver already.

`tools/lib/parse/driver.mjs:1384` picks a definition's parent as
`defs.filter((p) => within(def, p)).sort(innermostFirst)[0]`, and `:1402` then builds
`def.qname = ${qnameParent.qname}.${local}`. A node spanning the whole file encloses
every top-level definition in it, so **every top-level qname in the graph would gain a
file prefix**. Pass A calls a unique bare qname CERTAIN, and the driver's own comment at
`:1390-1395` records what that costs: moving one test helper under its `describe` left a
second one unique and produced three false certain rows pointing at an unrelated file.

A file node could be excluded from parent selection, from `OWNER_KINDS`, from
`memberOwnerSql`, and from every count the report prints. That is four exclusions
against zero benefit — the read path can produce the same rows with none of them.

## File Structure

| File | Responsibility |
|---|---|
| `tools/lib/destinations/local-sqlite.mjs` | Modify — `fileScopeCallers`, wire into `store.callers` and `store.impact`, drop `no-caller` from the gap report |
| `tools/lib/cli/commands.mjs` | Modify — render a file-scope row |
| `tools/__tests__/file-scope-callers.test.ts` | Create — the store returns file-scope rows, grouped, and never invents one |
| `tools/__tests__/cli-file-scope.test.ts` | Create — the printed answer lists them and says `✓ complete` |
| `tools/__tests__/cli-unresolved.test.ts` | Modify — the `no-caller` cases move from the banner to the list |

Five more files turned out to need changing, and none of them is in the table above:

| File | Why it was missed |
|---|---|
| `tools/__tests__/store-unresolved.test.ts` | Asserted `store.callers('Engine.start')` returns `[]`. Task 1 broke it and shipped red, because the plan's Task 1 named seven test files to run and this was not one of them. The fix strengthened the assertion: it now pins `kind === 'file'`, the exact line, and that the row is no longer a gap. |
| `tools/__tests__/impact-skipped-guesses.test.ts` | Pinned `reason === 'no-caller'` surviving in `impact`'s JSON gaps. `impact` had no task, so nothing in the plan flipped it. |
| `skills/_shared/templates/p-graph-rule.template.md` | In the plan (Task 4), but for one paragraph. Its `⚠` table row also had to change. |
| `README.md`, `skills/query/SKILL.md` | Both print a sample gap banner containing an `outside any indexed symbol` row, and `README.md` has a paragraph saying `callers` cannot show these rows at all. Outside the plan's stated file list, found while running the tasks. |

---

### Task 1: The store returns a file-scope caller row

**Files:**
- Modify: `tools/lib/destinations/local-sqlite.mjs` (`store.callers`, around the `withSites` / `SITES` helpers)
- Test: `tools/__tests__/file-scope-callers.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `fileScopeCallers(name)` returning rows shaped like a node row so every
  existing consumer can render them unchanged:
  `{ id: 'filescope:<file>', name: <basename>, qname: <file>, kind: 'file', lang, file, start_line: null, end_line: null, signature: null, doc: '', container_id: null, decl: 0, guess, call_sites: [{file, line}, …] }`
  `store.callers` returns node rows first, then these.

- [ ] **Step 1: Write the failing test**

Create `tools/__tests__/file-scope-callers.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-filescope-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};
const indexed = async () => {
  const store = openStore(':memory:');
  await indexFull({ root: dir, store, ignorePatterns: [] });
  return store;
};

// A call written outside any function has no enclosing symbol, so its edge holds
// `src_id = NULL` and the inner join in `callers` could never report it. It was
// reported instead in the gap banner, one line per call — and that banner is
// capped at 20 rows. Measured on hugo: `parse.mkItem` has 120 such call sites, 20
// were named and 100 were replaced by "… and 100 more". Across axios, nest, got
// and hugo, 13 symbols are over the cap and 1,500 rows are never named.
describe('a call written at file scope gets a caller row', () => {
  beforeEach(() => {
    write('lib/manager.js', `export class Manager {
  eject(id) { return id; }
}
`);
    write('app/boot.js', `import { Manager } from '../lib/manager.js';
const m = new Manager();
m.eject(1);
m.eject(2);
`);
  });

  it('lists the file, once, with every call site on it', async () => {
    const store = await indexed();

    const rows = store.callers('Manager.eject');
    const fileRows = rows.filter((r) => r.kind === 'file');
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0].qname).toBe('app/boot.js');
    expect(fileRows[0].call_sites.map((s) => s.line)).toEqual([3, 4]);
    store.close();
  }, 30000);

  it('keeps ordinary callers too, and puts them first', async () => {
    write('app/run.js', `import { Manager } from '../lib/manager.js';
export function run(m) { return m.eject(3); }
`);
    const store = await indexed();

    const kinds = store.callers('Manager.eject').map((r) => r.kind);
    expect(kinds).toContain('function');
    expect(kinds).toContain('file');
    expect(kinds.indexOf('file')).toBe(kinds.length - 1);
    store.close();
  }, 30000);

  // A row the resolver never tied to this symbol is not a call site of it. Only a
  // RESOLVED edge counts — the same rule the rest of `callers` follows.
  it('does not invent a row for an unresolved call', async () => {
    write('lib/other.js', `export class Other {
  eject(id) { return id; }
}
`);
    const store = await indexed();

    // Two definitions share the name, so the fallback refuses and nothing at file
    // scope resolves to either one.
    const fileRows = store.callers('Manager.eject').filter((r) => r.kind === 'file');
    expect(fileRows).toHaveLength(0);
    store.close();
  }, 30000);

  it('says whether the row rests on a guess', async () => {
    const store = await indexed();

    const fileRow = store.callers('Manager.eject').find((r) => r.kind === 'file');
    expect(fileRow.guess).toBeTypeOf('number');
    store.close();
  }, 30000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-graph/tools/__tests__/file-scope-callers.test.ts`

Expected: FAIL on the first, second and fourth cases — no row has `kind === 'file'`.
The third passes already (it asserts an absence).

- [ ] **Step 3: Add the helper and wire it into `store.callers`**

In `tools/lib/destinations/local-sqlite.mjs`, beside `store.callers`:

```js
  // A call written outside any function — a module's top level, a Go package-level
  // `var x = pkg.New()`, a `@Injectable()` on a class — has no enclosing symbol, so
  // its edge holds `src_id = NULL` and the join in `callers` above cannot see it.
  // Those calls were reported in the gap banner instead, one line each, and that
  // banner stops at GAP_LIMIT rows. Measured on hugo: `parse.mkItem` has 120 of
  // them, 20 were named and 100 were replaced by "… and 100 more". Across axios,
  // nest, got and hugo, 13 symbols are over the cap and 1,500 rows are never named.
  //
  // The row is shaped like a node row so every reader renders it unchanged, but no
  // node is stored. A node spanning the file would enclose every top-level
  // definition in it, and driver.mjs:1402 builds a child's qname from its parent's
  // — so every top-level qname in the graph would gain a file prefix. Pass A calls
  // a unique bare qname CERTAIN, and the driver's own comment at :1390 records
  // three false certain rows from moving one qname.
  //
  // Only a RESOLVED edge counts. An unresolved call at file scope is not a call
  // site of this symbol, and it stays in the gap report where it belongs.
  const fileScopeCallers = (ns) => db.prepare(`
    SELECT e.file, ${GUESS_COL} AS guess, ${SITES}
    FROM edges e JOIN nodes d ON d.id = e.dst_id
    WHERE e.kind = 'call' AND e.src_id IS NULL
      AND (d.name IN (${holes(ns.length)}) OR d.qname IN (${holes(ns.length)}))
    GROUP BY e.file ORDER BY e.file`).all(...ns, ...ns);
```

Then extend `store.callers` so the file rows come after the node rows:

```js
  const asFileRow = (r) => ({
    id: `filescope:${r.file}`,
    name: r.file.slice(r.file.lastIndexOf('/') + 1),
    qname: r.file, kind: 'file', lang: null, file: r.file,
    start_line: null, end_line: null, signature: null, doc: '',
    container_id: null, decl: 0, guess: r.guess,
  });
  store.callers = (name) => {
    const ns = matchNames(name);
    const nodeRows = withSites(db.prepare(`
      SELECT s.*, ${GUESS_COL} AS guess, ${SITES} FROM edges e JOIN nodes s ON s.id = e.src_id
      JOIN nodes d ON d.id = e.dst_id
      WHERE d.name IN (${holes(ns.length)}) OR d.qname IN (${holes(ns.length)})
      GROUP BY s.id`).all(...ns, ...ns));
    return [...nodeRows, ...withSites(fileScopeCallers(ns).map(asFileRow2))];
  };
```

Read the existing `withSites` and `SITES` before writing this: `withSites` strips a
`sites` key off each row, so `asFileRow` must pass `sites` through. Wire it whichever
way keeps `withSites` the single place that parses a site list — do not write a second
parser for the same string.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run plugins/p-graph/tools/__tests__/file-scope-callers.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 5: Run every suite that reads callers**

Run:
```bash
npx vitest run plugins/p-graph/tools/__tests__/store-read.test.ts \
  plugins/p-graph/tools/__tests__/call-sites.test.ts \
  plugins/p-graph/tools/__tests__/confidence.test.ts \
  plugins/p-graph/tools/__tests__/context-guess-split.test.ts \
  plugins/p-graph/tools/__tests__/member-call-owner.test.ts \
  plugins/p-graph/tools/__tests__/interface-reach.test.ts \
  plugins/p-graph/tools/__tests__/cli-query-basic.test.ts
```

Expected: PASS. A failure here means an existing reader cannot render a row with a
null `start_line` — report which one rather than papering over it; Task 2 is where the
rendering is fixed, so it may be right to note it and continue.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-graph/tools/lib/destinations/local-sqlite.mjs \
        plugins/p-graph/tools/__tests__/file-scope-callers.test.ts
git commit -m "feat(p-graph): give a call written at file scope a caller row"
```

---

### Task 2: The printed answer lists the file-scope rows

**Files:**
- Modify: `tools/lib/cli/commands.mjs` (`printCertainThenGuessed` and whatever it calls to format one row)
- Test: `tools/__tests__/cli-file-scope.test.ts`

**Interfaces:**
- Consumes: rows with `kind: 'file'`, `qname` = the path, `start_line: null`, from Task 1.
- Produces: one printed line per file, `file <path>  <line>, <line>`.

- [ ] **Step 1: Write the failing test**

Create `tools/__tests__/cli-file-scope.test.ts`. Follow the style of
`tools/__tests__/cli-unresolved.test.ts` for invoking the CLI — read that file first
and reuse its helper rather than writing a new one. Use the same fixture as Task 1
(`lib/manager.js` plus `app/boot.js` with two top-level calls), and assert:

```ts
  it('lists the file and its call sites in the main list', async () => {
    const text = run(['callers', 'Manager.eject']);
    expect(text).toContain('app/boot.js');
    expect(text).toMatch(/app\/boot\.js\s+3, 4/);
  });

  it('does not print a line number for the file itself', async () => {
    // A file has no declaration line. Printing `app/boot.js:null` or `:0` would
    // read as a location the reader could open.
    const text = run(['callers', 'Manager.eject']);
    expect(text).not.toMatch(/boot\.js:(null|undefined|0)\b/);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-graph/tools/__tests__/cli-file-scope.test.ts`

Expected: FAIL. Report exactly how it fails — a row with a null `start_line` may print
`app/boot.js:null`, or may throw. The failure text tells you what to fix.

- [ ] **Step 3: Render the row**

Change the row formatter in `tools/lib/cli/commands.mjs` so a `kind: 'file'` row prints
its path with no declaration line, and its call sites as it already does for a node row.
Keep the change to that one formatter — do not add a branch at each call site of it.

Add a one-line comment saying why the line number is absent: a file has no declaration
line, and printing one would read as a location the reader could open.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run plugins/p-graph/tools/__tests__/cli-file-scope.test.ts`

Expected: PASS, 2 tests.

- [ ] **Step 5: Run the CLI suites**

Run: `npx vitest run plugins/p-graph/tools/__tests__/cli-*.test.ts plugins/p-graph/tools/__tests__/complete-answer.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-graph/tools/lib/cli/commands.mjs \
        plugins/p-graph/tools/__tests__/cli-file-scope.test.ts
git commit -m "feat(p-graph): print a file-scope caller as the file, with no fake line"
```

---

### Task 3: A listed call is not a gap

**Files:**
- Modify: `tools/lib/destinations/local-sqlite.mjs` (the `no-caller` rows in `collectGaps`)
- Modify: `tools/__tests__/cli-unresolved.test.ts`
- Test: `tools/__tests__/cli-file-scope.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 1 and 2 — the rows are now in the main list.
- Produces: `✓ complete` on an answer whose only former gap was a file-scope call.

Tasks 1 and 2 put these calls in the list. Leaving them in the gap report as well
makes the answer contradict itself: 25 callers listed, and `⚠ 8 missing`. Worse, the
`⚠` line is now false — nothing is missing.

- [ ] **Step 1: Write the failing test**

Extend `tools/__tests__/cli-file-scope.test.ts` with the case that matters most:

```ts
  // `✓ complete` is the strongest claim this plugin makes — the rule reads it as
  // "stop. Do not grep." Before this work the answer listed 17 of axios's 25
  // `eject` call sites and printed `✓ complete`, which was false. Then it listed 17
  // and named 8 under `⚠`, which was true but cost the reader a pass. Now it lists
  // all of them, so the line is both true and free.
  it('says the answer is complete once nothing is missing', async () => {
    const text = run(['callers', 'Manager.eject']);
    expect(text).toContain('✓ complete');
    expect(text).not.toContain('missing from this answer');
    expect(text).not.toContain('outside any indexed symbol');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run plugins/p-graph/tools/__tests__/cli-file-scope.test.ts`

Expected: FAIL — the answer still prints `⚠ 2 call sites missing from this answer` and
`outside any indexed symbol`.

- [ ] **Step 3: Stop emitting `no-caller` gap rows**

In `collectGaps`, remove the `no-caller` rows — search for `reason: 'no-caller'`.
Before you delete anything, check **each** command that renders a gap report
(`callers`, `callees`, `impact`, `context`) and confirm the row is now listed there.
`gapsFrom` powers `callees`, and the target of a `callees` question is the caller, not
the callee — so if `no-caller` means something different on that path, keep it there
and say so in your report. Do not remove a report from a command that does not list
the rows: that would put back the exact failure this branch exists to fix.

Replace the reason's entry in the comment block that documents the reasons (around the
`'ambiguous'` / `'external'` list) with one line saying where the rows went and why.

- [ ] **Step 4: Update the tests that pinned the old behaviour**

`tools/__tests__/cli-unresolved.test.ts` asserts the `outside any indexed symbol` line.
Those cases now describe the wrong behaviour. Rewrite each so it asserts the row is in
the **list**, and keep the fixture — the fixture is the valuable part. Do not delete a
case: a deleted assertion is a coverage hole nobody sees.

- [ ] **Step 5: Run the tests**

Run:
```bash
npx vitest run plugins/p-graph/tools/__tests__/cli-file-scope.test.ts \
  plugins/p-graph/tools/__tests__/cli-unresolved.test.ts \
  plugins/p-graph/tools/__tests__/gap-*.test.ts \
  plugins/p-graph/tools/__tests__/complete-answer.test.ts \
  plugins/p-graph/tools/__tests__/all-guessed-answer.test.ts \
  plugins/p-graph/tools/__tests__/impact-skipped-guesses.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-graph/tools/lib/destinations/local-sqlite.mjs \
        plugins/p-graph/tools/__tests__/cli-unresolved.test.ts \
        plugins/p-graph/tools/__tests__/cli-file-scope.test.ts
git commit -m "fix(p-graph): a call the answer now lists is not a gap"
```

---

### Task 4: Update the rule, then verify on the real clones

**Files:**
- Modify: `skills/_shared/templates/p-graph-rule.template.md`
- Modify: `docs/superpowers/plans/2026-08-31-file-scope-callers.md` (this file — record what was measured)

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: the numbers the re-measurement will be read against.

- [ ] **Step 1: Correct the rule**

Commit `b7f67b8` on the previous branch added a paragraph and a table row telling the
reader that a `⚠` row marked `outside any indexed symbol` is a confirmed call site to
be put straight in the list. After Task 3 no such row is printed — the rows are in the
list already. Both the table row and the paragraph now describe a state that cannot
happen.

Rewrite them to say what is true after this plan: a call written outside any function
appears in the main list as its file, with its line numbers, and there is nothing extra
to do with it. Keep the rest of the `⚠` row — it still governs the rows that really are
candidates the graph could not settle.

Do not delete the axios example. Update its numbers: the answer now lists all 25 and
says `✓ complete`.

- [ ] **Step 2: Run the whole suite under WSL**

A Windows-only run verifies nothing in this repo.

```bash
wsl -e bash -lc 'export PATH=$HOME/.local/node24/bin:$PATH && cd /mnt/c/projects/perky.team/claude-plugin && tar --exclude=./node_modules --exclude=./.git --exclude=./.beads -cf - . | (cd ~/pshed && tar -xf -) && cd ~/pshed && npx vitest run 2>&1 | tail -6'
```

Expected: no new failure against the 2,845-test baseline. Report both platforms and say
which is the WSL run.

- [ ] **Step 3: Rebuild the clones and measure what moved**

The clones sit under `C:/Users/Andrey.Sukharev/AppData/Local/Temp/pgraph-measure`.
`axios`, `nest`, `got` and `hugo` are the four with file-scope callers worth measuring.

```bash
W="/c/Users/Andrey.Sukharev/AppData/Local/Temp/pgraph-measure"
P=/c/projects/perky.team/claude-plugin/plugins/p-graph/tools/pgraph.mjs
for r in axios nest got hugo; do (cd "$W/$r" && node "$P" index); done
(cd "$W/axios" && node "$P" callers InterceptorManager.eject)
(cd "$W/hugo" && node "$P" callers parse.mkItem)
(cd "$W/nest" && node "$P" callers Injectable)
```

Report, for each of those three symbols and for the four repos overall:

| | before | after |
|---|---|---|
| rows in the main list | | |
| rows in the `⚠` banner | | |
| rows named nowhere (the `… and N more` tail) | | |
| the completeness line | | |

The number that decides whether this worked is the third row: it was 1,500 across four
repos and it should be 0. The number that decides whether it is worth shipping is the
second: the banner should get shorter, not longer.

- [ ] **Step 4: Write the measured numbers into this plan**

Replace the estimates in "What was measured" with what actually happened, in the voice
this project uses for a corrected figure. The previous branch's own estimate was five
times too high; do not let this one stand uncorrected.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-graph/skills/_shared/templates/p-graph-rule.template.md \
        plugins/p-graph/docs/superpowers/plans/2026-08-31-file-scope-callers.md
git commit -m "docs(p-graph): the rule and the plan, after file-scope calls became list rows"
```

---

## What is deliberately not built

- **No file node in the graph.** See "Why not a file node".
- **No change to `GAP_LIMIT`.** The cap is right; the fix is to stop filling the banner.
- **Pass C (`this.m()`) is untouched.** It still resolves a call to a `.d.ts`
  declaration and then prints `✓ complete` while missing a real call site. Measured on
  the previous branch, byte-identical on `cad73e2`, so it is pre-existing. Widening it
  creates new resolved rows and needs its own measurement.
- **No re-measurement inside this plan.** One run of the graph arm, after this lands,
  covers both this work and the ts/js branch. It is approved at about $34 and 100
  minutes and it is the next thing after Task 4.
