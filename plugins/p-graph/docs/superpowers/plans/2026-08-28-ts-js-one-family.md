# TypeScript and JavaScript are one language for resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a call written in a `.ts` file resolve to the method defined in a `.js`
file beside it, and stop a published `index.d.ts` from competing with the code it
describes.

**Architecture:** Two guards in the resolver read `ts` and `js` as different
languages. They are not: the graph already writes `lang IN ('ts','js')` in eight other
places. Widen exactly those two guards, and add one rule so widening does not create
new ambiguity — a declaration file states an API, it does not define one.

**Tech Stack:** Node 24+ for the suite (22.5+ for the plugin), `node:sqlite`,
vendored tree-sitter. No npm dependencies.

## Global Constraints

- **No new npm dependency.** p-graph ships with `node:sqlite` and vendored grammars.
- **Node 22.5 is the plugin's runtime floor; the test suite needs Node 24+.**
- **Every test run happens under WSL, and the whole suite** (see `.claude/CLAUDE.md`).
- **`SCHEMA_VERSION` must be bumped** in Task 1: stored `nodes.decl` values change, so
  an existing graph must be erased and rebuilt rather than read as if current.
- **Comments explain WHY with the measured number**, in Simple English, matching the
  voice of the comments already in these two files.
- **Only `ts` and `js` join.** `cpp` and `py` stay apart. That split is what keeps
  re2's Python binding out of a C++ symbol's gap list, and `gap-language.test.ts`
  asserts it.

---

## What was measured, and why the report's stated cause is wrong

`measured-benefit.md` says `axios-eject` (51 of 75, p-graph's single worst question)
is blocked by "a two-level chain off an object literal". That is not what blocks it.
Measured today against the study's own axios index:

```
$ node tools/pgraph.mjs callers InterceptorManager.eject
  11 certain call sites   tests/unit/core/InterceptorManager.test.js
   6 guesses              tests/browser/*, tests/smoke/*
  OK complete — no gaps: the graph accounted for every call site it found.
```

17 of 25. The 8 that are missing are all in `.ts` files:

| File | Lines |
|---|---|
| `tests/module/cjs/tests/helpers/cjs-typing.ts` | 316, 333, 357, 358 |
| `tests/module/esm/tests/helpers/esm-index.ts` | 344, 359, 383, 384 |

Their edges **are in the database**, with `dst_name='eject'`, `dst_id=NULL`,
`guess=0`. Two guards, each doing exactly what it was written to do, keep them
unresolved and unreported:

1. **The bare-name fallback is scoped by language.** `local-sqlite.mjs:1114-1123`
   writes `n.lang = edges.lang` three times. The edges are `lang='ts'`; the method is
   `lang='js'`. The identical rows in `.js` test files resolve — those 6 guesses above
   are exactly them.
2. **The gap report is scoped by language.** `collectGaps` drops every matched row
   whose lang is not the target's. So the 8 rows are not listed as gaps either, and
   the banner claims the answer is complete. The p-graph rule then tells the agent:
   *"stop. Do not grep."* This is the lying-banner case, on a real question, costing
   24 of the 33 call sites p-graph is behind grep study-wide.

A third fact decides the design. Widening the language guard alone would make things
**worse**: axios publishes `index.d.ts` and `index.d.cts`, and both declare
`AxiosInterceptorManager.eject`. Unified, the bare name `eject` would have three
callable nodes instead of one, the "exactly one" guard would refuse, and the 6 sites
that work today would be lost. 18 names in axios are ambiguous for this reason and no
other.

So the two changes must land together. Simulated over the study's three TypeScript
indexes, before writing any code:

| Repo | nodes | `.d.ts` nodes | bare names newly unique | **newly ambiguous** |
|---|---:|---:|---:|---:|
| axios | 3,279 | 44 | **+95** | **0** |
| nest | 11,031 | 0 | +9 | **0** |
| got | 3,317 | 0 | +12 | **0** |

Nothing is lost anywhere. Task 4 re-runs that count against the rebuilt graphs.

## File Structure

| File | Responsibility |
|---|---|
| `tools/lib/parse/driver.mjs` | Modify — mark a node from a `.d.ts` file as a declaration |
| `tools/lib/destinations/local-sqlite.mjs` | Modify — `SAME_LANG` / `langFamily` helpers, Pass B, `collectGaps`, `SCHEMA_VERSION` |
| `tools/__tests__/ts-declaration-files.test.ts` | Create — a `.d.ts` method is marked as a declaration |
| `tools/__tests__/ts-js-one-family.test.ts` | Create — a `.ts` call reaches a `.js` method, and a declaration does not block it |
| `tools/__tests__/gap-language.test.ts` | Modify — add the ts/js case beside the existing cpp/py cases |

---

### Task 1: A TypeScript declaration file declares, it does not define

**Files:**
- Modify: `tools/lib/parse/driver.mjs` (near the top-level constants, and `nodes = defs.map(...)` around line 1440)
- Modify: `tools/lib/destinations/local-sqlite.mjs:88` (`SCHEMA_VERSION`)
- Test: `tools/__tests__/ts-declaration-files.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `nodes.decl = 1` for every node extracted from a file matching
  `/\.d\.(c|m)?ts$/`. Task 2 reads that column.

- [ ] **Step 1: Write the failing test**

Create `tools/__tests__/ts-declaration-files.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsdecl-')); });
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

// A published `index.d.ts` restates the API of the code beside it, under names of
// its own. axios ships two of them, `index.d.ts` and `index.d.cts`, and between
// them they declare `AxiosInterceptorManager.eject` twice for the one
// `InterceptorManager.eject` in `lib/`. Counted as definitions, those twins make
// 18 bare names in axios ambiguous and nothing else does. A header already yields
// to its definition in C++; this is the same rule for the same reason.
describe('a TypeScript declaration file is marked as declarations', () => {
  it('marks every node from a .d.ts file', async () => {
    write('index.d.ts', `export declare class ApiInterceptor {
  eject(id: number): void;
}
`);
    const store = await indexed();

    const eject = store.symbolsNamed('eject').filter((n) => n.file === 'index.d.ts');
    expect(eject).toHaveLength(1);
    expect(eject[0].decl).toBe(1);
    store.close();
  }, 30000);

  it('marks .d.cts and .d.mts the same way', async () => {
    write('index.d.cts', `export declare class ApiInterceptor { eject(id: number): void; }\n`);
    write('index.d.mts', `export declare class ApiInterceptor { eject(id: number): void; }\n`);
    const store = await indexed();

    for (const f of ['index.d.cts', 'index.d.mts']) {
      const n = store.symbolsNamed('eject').filter((x) => x.file === f);
      expect(n, f).toHaveLength(1);
      expect(n[0].decl, f).toBe(1);
    }
    store.close();
  }, 30000);

  // The guard is on the whole suffix, not on a bare `.d`. A file named
  // `schema.d.ts` is a declaration; one named `payload.ts` is not, wherever it sits.
  it('leaves an ordinary .ts file alone', async () => {
    write('lib/api.ts', `export class Api {
  send(x: number): void {}
}
`);
    const store = await indexed();

    const send = store.symbolsNamed('send').filter((n) => n.file === 'lib/api.ts');
    expect(send).toHaveLength(1);
    expect(send[0].decl).toBe(0);
    store.close();
  }, 30000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-graph/tools/__tests__/ts-declaration-files.test.ts`

Expected: FAIL — the first two cases report `decl` as `0`, not `1`. The third passes
already.

- [ ] **Step 3: Mark declaration files in the driver**

In `tools/lib/parse/driver.mjs`, add the constant beside the other top-level regexes:

```js
// A TypeScript declaration file states an API, it does not define one. axios
// publishes `index.d.ts` and `index.d.cts`, and between them they restate every
// public method of `lib/` under a qname of their own — `AxiosInterceptorManager.eject`
// for `InterceptorManager.eject`. Counted as definitions, those twins made 18 bare
// names in axios ambiguous, which is what stopped the bare-name fallback from
// answering `eject` at all. A C++ header already yields to its definition; this is
// the same rule for the same reason.
const TS_DECL_FILE = /\.d\.(c|m)?ts$/;
```

Then in `extract()`, where nodes are built (around line 1440), read it once and fold
it in:

```js
  const declFile = TS_DECL_FILE.test(file);
  const nodes = defs.map((d) => ({
    id: d.id, name: d.name, qname: d.qname, kind: d.kind, lang,
    file, start_line: d.startLine, end_line: d.endLine,
    signature: d.signature, doc: '', container_id: d.container_id,
    decl: (d.decl || declFile) ? 1 : 0,
  }));
```

- [ ] **Step 4: Bump the schema version**

`nodes.decl` now holds different values for the same repo, so a graph written by the
old code must be rebuilt rather than read as current. In
`tools/lib/destinations/local-sqlite.mjs`, change line 88 and add the note to the list
of schema changes above it, matching the style of entries 12 and 13:

```js
// 14: a node extracted from a TypeScript declaration file (`.d.ts`, `.d.cts`,
// `.d.mts`) is marked `decl = 1`. Stored values change for every repo that ships
// one, so the graph is rebuilt rather than read as current.
export const SCHEMA_VERSION = 14;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run plugins/p-graph/tools/__tests__/ts-declaration-files.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 6: Run the neighbouring suites**

Run:
```bash
npx vitest run plugins/p-graph/tools/__tests__/lang-ts.test.ts \
  plugins/p-graph/tools/__tests__/lang-js.test.ts \
  plugins/p-graph/tools/__tests__/cpp-decl-vs-def.test.ts \
  plugins/p-graph/tools/__tests__/driver.test.ts
```

Expected: PASS. `cpp-decl-vs-def` must stay green — the C++ path sets `d.decl` itself
and this change only adds a second source into it.

- [ ] **Step 7: Commit**

```bash
git add plugins/p-graph/tools/lib/parse/driver.mjs \
        plugins/p-graph/tools/lib/destinations/local-sqlite.mjs \
        plugins/p-graph/tools/__tests__/ts-declaration-files.test.ts
git commit -m "feat(p-graph): a .d.ts file declares, it does not define"
```

---

### Task 2: The bare-name fallback reads ts and js as one language

**Files:**
- Modify: `tools/lib/destinations/local-sqlite.mjs` (new helpers near `SCHEMA_VERSION`; Pass B at lines 1111-1124)
- Test: `tools/__tests__/ts-js-one-family.test.ts`

**Interfaces:**
- Consumes: `nodes.decl = 1` on `.d.ts` nodes, from Task 1.
- Produces: `SAME_LANG(a, b)` — a SQL fragment builder — and `langFamily(lang)` — its
  JavaScript twin. Task 3 uses `langFamily`.

- [ ] **Step 1: Write the failing test**

Create `tools/__tests__/ts-js-one-family.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsjs-')); });
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

// axios, cut down to the shape that was measured. The library is JavaScript, the
// tests are TypeScript, and a published `index.d.ts` restates the API. Asked who
// calls `InterceptorManager.eject`, the graph named 17 of 25 call sites and then
// said the answer was complete: the 8 it missed are all written in `.ts` files, and
// the bare-name fallback would only look at `ts` nodes. That is p-graph's worst
// question in the whole study and 24 of the 33 call sites it trails grep by.
describe('a call in TypeScript reaches a method defined in JavaScript', () => {
  beforeEach(() => {
    write('lib/InterceptorManager.js', `export default class InterceptorManager {
  eject(id) { this.handlers[id] = null; }
}
`);
    write('tests/use.ts', `import client from '../lib/client.js';
client.interceptors.request.eject(1);
`);
  });

  it('resolves the call', async () => {
    const store = await indexed();

    const sites = store.callers('InterceptorManager.eject')
      .flatMap((c) => c.call_sites).map((s) => s.file);
    expect(sites).toContain('tests/use.ts');
    store.close();
  }, 30000);

  // Only by name — nothing read the receiver's type — so the row must say so.
  // A certain row here would be a false promise.
  it('marks it as a guess', async () => {
    const store = await indexed();

    const rows = store.callers('InterceptorManager.eject')
      .filter((c) => c.call_sites.some((s) => s.file === 'tests/use.ts'));
    expect(rows).toHaveLength(1);
    expect(rows[0].guess).toBe(1);
    store.close();
  }, 30000);

  // The regression this task exists to avoid. With `.d.ts` counted as a definition,
  // the bare name `eject` has two callable nodes once the languages are joined, the
  // "exactly one" guard refuses, and the call sites that resolved BEFORE this change
  // are lost. A declaration must not count while a definition of that name exists.
  it('is not blocked by a published declaration of the same API', async () => {
    write('index.d.ts', `export declare class AxiosInterceptorManager {
  eject(id: number): void;
}
`);
    const store = await indexed();

    const sites = store.callers('InterceptorManager.eject')
      .flatMap((c) => c.call_sites).map((s) => s.file);
    expect(sites).toContain('tests/use.ts');
    store.close();
  }, 30000);

  // The declaration is kept, not deleted: it is a symbol of the repo and a reader
  // may ask about it by name.
  it('keeps the declared symbol in the graph', async () => {
    write('index.d.ts', `export declare class AxiosInterceptorManager {
  eject(id: number): void;
}
`);
    const store = await indexed();

    expect(store.symbolsNamed('eject').map((n) => n.file)).toContain('index.d.ts');
    store.close();
  }, 30000);

  // Two real definitions are still ambiguous. Joining the languages must not turn
  // "we do not know which" into a guess.
  it('still refuses when two real definitions share the name', async () => {
    write('lib/Other.js', `export default class Other {
  eject(id) { return id; }
}
`);
    const store = await indexed();

    const sites = store.callers('InterceptorManager.eject')
      .flatMap((c) => c.call_sites).map((s) => s.file);
    expect(sites).not.toContain('tests/use.ts');
    store.close();
  }, 30000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-graph/tools/__tests__/ts-js-one-family.test.ts`

Expected: FAIL on the first three cases — `tests/use.ts` is not among the call sites.
The last two pass already; they pin what today's code gets right.

- [ ] **Step 3: Add the two language-family helpers**

In `tools/lib/destinations/local-sqlite.mjs`, below `SCHEMA_VERSION`:

```js
// `ts` and `js` are one language for resolution. A repository that ships
// JavaScript, writes its tests in TypeScript and publishes an `index.d.ts` is not
// three repositories, and every type-reading pass in this file already says so with
// `lang IN ('ts','js')`. Measured on axios: the eight top-level
// `axios.interceptors.request.eject(...)` calls are `ts` rows and the method they
// call is a `js` node, so the bare-name fallback could never see it — while the
// identical calls in `.js` test files resolved.
//
// Nothing else joins. cpp and py stay apart, and that is deliberate: on re2, a C++
// library with a Python binding, matching across languages put seven Python calls to
// an unrelated `Match` into a C++ symbol's gap list. See gap-language.test.ts.
const langFamily = (lang) => (lang === 'ts' || lang === 'js' ? 'tsjs' : lang);
const SAME_LANG = (a, b) =>
  `((${a} = ${b}) OR (${a} IN ('ts','js') AND ${b} IN ('ts','js')))`;
```

- [ ] **Step 4: Widen Pass B, and make a definition beat a declaration**

Replace the statement at `tools/lib/destinations/local-sqlite.mjs:1111-1124` — keep
every comment above it as it stands, and add this one directly above the new
`definitionWins` constant:

```js
    // A declaration is not a rival definition. Joining ts and js below would
    // otherwise LOSE call sites that resolve today: axios publishes `index.d.ts`
    // and `index.d.cts`, both declaring `AxiosInterceptorManager.eject`, so the
    // bare name `eject` would have three callable nodes where it has one, and the
    // "exactly one" guard would refuse them all. 18 names in axios are ambiguous for
    // this reason and no other. So when a name has a real definition, declarations
    // of that name stop counting — and the declared node stays in the graph, because
    // a reader may still ask about it. A graph written before schema 9 has no `decl`
    // column and nothing is marked, so the guard is left out entirely there.
    const definitionWins = declColumn()
      ? `AND (n.decl = 0 OR NOT EXISTS (
           SELECT 1 FROM nodes d
           WHERE d.name = n.name AND d.kind IN ${CALLABLE} AND d.decl = 0
             AND ${SAME_LANG('d.lang', 'n.lang')}))`
      : '';
    db.prepare(`
      UPDATE edges SET dst_id = (
        SELECT n.id FROM nodes n
        WHERE n.name = edges.dst_name AND ${SAME_LANG('n.lang', 'edges.lang')}
          AND n.kind IN ${CALLABLE} AND ${MEMBER_TARGET_OK} ${definitionWins}
        LIMIT 1
      ), guess = 1
      WHERE kind = 'call' AND dst_id IS NULL AND dst_name IS NOT NULL AND external = 0
        AND (SELECT count(*) FROM nodes n
             WHERE n.qname = edges.dst_name AND ${SAME_LANG('n.lang', 'edges.lang')}) = 0
        AND (SELECT count(*) FROM nodes n
             WHERE n.name = edges.dst_name AND ${SAME_LANG('n.lang', 'edges.lang')}
               AND n.kind IN ${CALLABLE} ${definitionWins}) = 1
        AND EXISTS (SELECT 1 FROM nodes n
             WHERE n.name = edges.dst_name AND ${SAME_LANG('n.lang', 'edges.lang')}
               AND n.kind IN ${CALLABLE} AND ${MEMBER_TARGET_OK} ${definitionWins})
        AND NOT EXISTS (
```

Everything from `SELECT 1 FROM field_types ft` to the end of the statement is
unchanged — do not retype it, and do not touch its comments.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run plugins/p-graph/tools/__tests__/ts-js-one-family.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 6: Run every suite that touches TypeScript or JavaScript resolution**

Run:
```bash
npx vitest run plugins/p-graph/tools/__tests__/ts-*.test.ts \
  plugins/p-graph/tools/__tests__/js-var-types.test.ts \
  plugins/p-graph/tools/__tests__/lang-js.test.ts \
  plugins/p-graph/tools/__tests__/false-edges.test.ts \
  plugins/p-graph/tools/__tests__/gap-bare-name.test.ts \
  plugins/p-graph/tools/__tests__/confidence.test.ts \
  plugins/p-graph/tools/__tests__/resolve-idempotent.test.ts
```

Expected: PASS. A failure here is the signal that widening the guard costs a row
somewhere — report the failing assertion rather than adjusting the test.

- [ ] **Step 7: Commit**

```bash
git add plugins/p-graph/tools/lib/destinations/local-sqlite.mjs \
        plugins/p-graph/tools/__tests__/ts-js-one-family.test.ts
git commit -m "fix(p-graph): resolve a TypeScript call to the JavaScript method it names"
```

---

### Task 3: The gap report reads ts and js as one language

**Files:**
- Modify: `tools/lib/destinations/local-sqlite.mjs`, inside `collectGaps` (the two lines that filter `matched` by lang, around line 1634)
- Test: `tools/__tests__/gap-language.test.ts`

**Interfaces:**
- Consumes: `langFamily(lang)` from Task 2.
- Produces: nothing further.

This is the honesty half, and it stands on its own. Even with Task 2 in place a `.ts`
row can stay unresolved — two real definitions share the name, or the receiver is
typed as something else. Today such a row is dropped from the gap list for a `js`
target, so the banner claims the answer is complete and the p-graph rule tells the
agent *"stop. Do not grep."* A short list the reader is told to trust is worse than a
long one that admits what it missed.

- [ ] **Step 1: Write the failing test**

Append to `tools/__tests__/gap-language.test.ts`:

```ts
// The other half of the same rule. cpp and py are different languages and a row
// from one can never answer the other. ts and js are NOT: axios defines its
// methods in `lib/*.js` and calls them from `tests/**/*.ts`. Measured there —
// `callers InterceptorManager.eject` named 17 of 25 call sites and then reported no
// gaps, because the 8 it missed are `ts` rows and the target is a `js` node. The
// p-graph rule reads that banner as "stop, do not grep", so the agent had no way to
// recover. A gap the reader is not told about is the one failure this report exists
// to prevent.
describe('the gap report treats ts and js as one language', () => {
  beforeEach(() => {
    write('lib/manager.js', `export class Manager {
  eject(id) { return id; }
}
`);
    // Two real definitions of the name, so the bare-name fallback refuses and the
    // row stays an honest gap instead of resolving.
    write('lib/other.js', `export class Other {
  eject(id) { return id; }
}
`);
    write('tests/use.ts', `import client from '../lib/client.js';
client.interceptors.request.eject(1);
`);
  });

  it('lists a TypeScript call site as a gap of a JavaScript symbol', async () => {
    const store = await indexed();

    expect(store.gapsFor('Manager.eject').map((g) => g.file)).toContain('tests/use.ts');
    store.close();
  }, 30000);

  it('gapsAround keeps the same rule', async () => {
    const store = await indexed();

    expect(store.gapsAround('Manager.eject').map((g) => g.file)).toContain('tests/use.ts');
    store.close();
  }, 30000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-graph/tools/__tests__/gap-language.test.ts`

Expected: FAIL on the two new cases — `tests/use.ts` is absent. The four existing
cases must already pass and must keep passing.

- [ ] **Step 3: Widen the filter**

In `collectGaps`, replace the two lines that filter `matched` by language. Keep the
re2 sentences exactly as they are and add the second paragraph:

```js
    // A call written in another language can never be the missing answer. The
    // rows were matched by name alone, and on re2 — a C++ library with a Python
    // binding — that put seven Python calls to an unrelated `Match` into the
    // first twenty rows of a C++ symbol's gap list. A longer banner nobody
    // believes is worse than a shorter one. With no target found there is no
    // language to filter by, so that case keeps every row.
    //
    // "Another language" does not mean "another file extension". ts and js are one
    // family here, for the reason `langFamily` gives. Measured on axios: the eight
    // `.ts` call sites of a `js` method were dropped by this filter, so the banner
    // said the answer was complete while missing 8 of 25 — and the rule reads that
    // banner as "stop, do not grep".
    const langs = new Set(symbols.map((s) => s.lang).filter(Boolean).map(langFamily));
    if (langs.size) matched = matched.filter((r) => langs.has(langFamily(r.lang)));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run plugins/p-graph/tools/__tests__/gap-language.test.ts`

Expected: PASS, 6 tests — the four cpp/py cases and the two new ts/js cases.

- [ ] **Step 5: Run the rest of the gap and answer suites**

Run:
```bash
npx vitest run plugins/p-graph/tools/__tests__/gap-*.test.ts \
  plugins/p-graph/tools/__tests__/complete-answer.test.ts \
  plugins/p-graph/tools/__tests__/all-guessed-answer.test.ts \
  plugins/p-graph/tools/__tests__/cli-unresolved.test.ts \
  plugins/p-graph/tools/__tests__/interface-reach.test.ts \
  plugins/p-graph/tools/__tests__/cli-implementation-reach.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-graph/tools/lib/destinations/local-sqlite.mjs \
        plugins/p-graph/tools/__tests__/gap-language.test.ts
git commit -m "fix(p-graph): stop hiding a TypeScript gap in a JavaScript symbol's answer"
```

---

### Task 4: Verify on the real repositories, then re-measure

**Files:**
- Modify: `plugins/p-graph/docs/measured-benefit.md` (the `axios-eject` cause, and the figures the re-run moves)
- Modify: `plugins/p-graph/docs/superpowers/plans/2026-08-14-p-graph-lsp-arm.md` (the same wrong cause is repeated there)

**Interfaces:**
- Consumes: all three tasks.
- Produces: the measured numbers the report will carry.

- [ ] **Step 1: Run the whole suite under WSL**

The project rule is absolute: a Windows-only run does not verify anything.

```bash
wsl -e bash -lc 'export PATH=$HOME/.local/node24/bin:$PATH && cd ~/pshed && npx vitest run'
```

Expected: the same file and test counts as `main` (289 files, 2,830 passed, 14
skipped) plus the two new files, and no new failure. Report both platforms' numbers
and say plainly which one is the WSL run.

- [ ] **Step 2: Rebuild the three TypeScript indexes and check the answer moved**

The schema bump erases each graph, so this is a full rebuild.

```bash
W="/c/Users/Andrey.Sukharev/AppData/Local/Temp/pgraph-measure"
P=/c/projects/perky.team/claude-plugin/plugins/p-graph/tools/pgraph.mjs
for r in axios nest got; do (cd "$W/$r" && node "$P" index); done
(cd "$W/axios" && node "$P" callers InterceptorManager.eject)
```

Expected: 25 call sites in the answer — 11 certain and 14 marked as guesses — across
all seven files the truth list names. If any row is still missing, the banner must now
say how many are missing, never that the answer is complete.

- [ ] **Step 3: Prove nothing was lost anywhere**

Write this to the scratchpad, not into the repo, and run it against each rebuilt
index:

```js
// resolved-count.mjs
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(`${process.argv[2]}/.pgraph/graph.db`);
const r = db.prepare(`SELECT
  SUM(CASE WHEN dst_id IS NOT NULL AND guess = 0 THEN 1 ELSE 0 END) AS certain,
  SUM(CASE WHEN dst_id IS NOT NULL AND guess = 1 THEN 1 ELSE 0 END) AS guesses,
  SUM(CASE WHEN dst_id IS NULL THEN 1 ELSE 0 END) AS unresolved
  FROM edges WHERE kind='call' AND external=0 AND lang IN ('ts','js')`).get();
console.log(process.argv[2], JSON.stringify(r));
```

Expected: `certain` does not fall in any of the three repos. A drop there means a call
that was read from a type is now being guessed. That is a regression this plan did not
intend — stop and report it rather than accepting the recall win.

- [ ] **Step 4: Ask before re-measuring, then re-measure the graph arm**

This changes how p-graph resolves names, so `.claude/CLAUDE.md` requires asking the
user before treating any published number as still true. State the cost: about **$34**
and roughly 100 minutes for the graph arm, all fourteen repositories and all
questions — not only the TypeScript ones. A partial re-run has twice given this study
the wrong headline.

```bash
node plugins/p-graph/scripts/measure-agent.mjs --phase graph
node plugins/p-graph/scripts/measure-agent.mjs --score
```

- [ ] **Step 5: Correct the stated cause in both documents**

`measured-benefit.md` says `axios-eject` is blocked by "a two-level chain off an object
literal (`this.interceptors = {request: new InterceptorManager(), …}`). 2,433 chain
calls across the three repos wait behind that shape." Measured, that is the wrong cause
for this question: the chain shape is why no row is CERTAIN, but every one of the 8
missing sites was missing because of the language split and the declaration twins. The
2,433 chain calls are a real and separate item and stay on the list.

Correct it in the page's own voice for a withdrawn claim. Do not overwrite it:

```markdown
> **Withdrawn.** This named the object-literal chain as what keeps `axios-eject` at 51
> of 75. It is not. The eight missing call sites are all in `.ts` files calling a `js`
> method, and two guards — the bare-name fallback and the gap report — each read the
> two as different languages. Fixed 28 August; the chain shape stays open, and it
> costs certainty rather than recall.
```

Then update the same claim where the LSP-arm plan repeats it.

- [ ] **Step 6: Print the full scoreboard**

End the report with the complete table for all four languages and all three arms, not
a delta. A partial table is how this study has twice published a wrong headline.

- [ ] **Step 7: Commit**

```bash
git add plugins/p-graph/docs/
git commit -m "docs(p-graph): re-measure after ts and js became one language"
```
