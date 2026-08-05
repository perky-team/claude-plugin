# TypeScript type facts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the graph its first recorded type facts for TypeScript, so a call written on a value stops being answered by a bare-name guess — removing the 89 false rows on sindresorhus/got, the single largest source of wrong answers left.

**Architecture:** Reuse the machinery Go and Python already use, and add nothing new to the resolver. Extraction learns two things about TypeScript: which names a scope binds (so a call on a name can be keyed) and what type the source states for them (so the key has a type). The existing Pass F resolves `<type>.<method>` from that key, and the existing Pass B guard refuses a bare-name guess whenever a type is recorded but leads nowhere. One new rule is TypeScript-only: an unannotated parameter records that its type is stated elsewhere, which is what turns got's 89 wrong rows into gap rows.

**Tech Stack:** Node ≥ 22.5 (`node:sqlite`), web-tree-sitter with the vendored TypeScript grammar, vitest, tree-sitter query files (`.scm`).

## Global Constraints

- Node ≥ 22.5 is the shipped runtime floor; the test suite requires Node ≥ 24 (`.claude/CLAUDE.md`).
- Run the e2e suites under WSL as well when implementing on Windows, and report both platforms' numbers (`.claude/CLAUDE.md`).
- Every claim about precision must come from `node plugins/p-graph/scripts/measure.mjs`, which exits non-zero if one certain row has no reason behind it.
- A rule that removes rows must be measured for recall cost before it ships. The branch's own history: a subtractive rule shipped on its own once cut 2,972 hugo guesses of which most were correct.
- `field_types.type` values beginning with `#` are markers, not type names: `#ret:` (a callee) and `#embed` (an embedded Go type) exist today. New markers follow the same shape.
- Never write a marker that could collide with a real type name. `#` is not legal in a TypeScript, Go or Python identifier.
- No new SQL pass. If a change seems to need one, stop and re-read Pass F, Pass R and Pass B first.

## Where the clones live

`measure.mjs` keeps its pinned clones in `$TMPDIR/pgraph-measure` unless `--work DIR`
says otherwise. Every `<work>` below means that directory — check it with
`node plugins/p-graph/scripts/measure.mjs --repos requests` once and use the path it
prints. `--no-clone` reuses what is already there.

## Measured starting point

Facts this plan is built on, all read from the source of the seven pinned clones, not inferred:

| Symbol | Rows | Receiver, as written | Verdict |
|---|---|---|---|
| got `setHeader` | **89** | `response.setHeader(...)`, `destination.setHeader(...)` — an **unannotated parameter** of a callback (`server.all('/x', async (request, response) => …)`) | all 89 **false** |
| nest `createNestApplication` | **190** | `module.createNestApplication()` where `const module = await Test.createTestingModule({…}).compile()` — an unannotated **const from a chained call on a package import** | all 190 **correct**, shown as guesses |

The two shapes must be told apart, or the fix trades 190 right answers for 89 wrong ones. They differ syntactically: a **parameter** versus a **variable with an initialiser**. That difference is what Task 3 keys on.

**Non-goal, with the reason:** making nest's 190 rows certain. It needs `@nestjs/testing` mapped to `packages/testing` (a monorepo package name resolved to a directory), then `Test` resolved to a repo class, then the result type of two chained methods including an `await`. Four new facts for 190 rows that are already correct and already marked. Not in this plan.

---

### Task 1: Bind TypeScript names, and key a call written on one

**Files:**
- Modify: `plugins/p-graph/tools/lib/parse/lang/ts.scm` (add parameter and variable captures)
- Modify: `plugins/p-graph/tools/lib/parse/driver.mjs` (a TS scope set, a binding map, and a key for a member call)
- Test: `plugins/p-graph/tools/__tests__/ts-var-types.test.ts` (create)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `TS_SCOPE_NODES: Set<string>` — module-level constant in `driver.mjs`.
  - `tsVarKeyAt(name: string, node: TreeSitterNode) => string | null` — returns the key of the binding in scope at that node, or null.
  - Key shapes, used by Tasks 2 and 3: `"<def id>#var:<name>@<line>:<col>"` for a binding inside a definition, `"<file>#var:<name>@<line>:<col>"` for one that is not.
  - `edges.field_key` is set on a TS/JS member call whose receiver is a plain bound name; `edges.method` holds the called name.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-graph/tools/__tests__/ts-var-types.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsvar-')); });
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

describe('a call on a TypeScript name carries that name as its key', () => {
  it('keys a member call on a parameter', async () => {
    write('app.ts', `export class Conn {
  query(q: string) { return q; }
}
export function read(c: Conn) {
  return c.query('1');
}
`);
    const s = await indexed();

    const row = s.db.prepare(
      `SELECT field_key, method FROM edges WHERE kind = 'call' AND dst_bare = 'query'`).get();
    expect(row.method).toBe('query');
    expect(row.field_key).toMatch(/#var:c@/);

    s.close();
  }, 30000);

  it('does not key a call on this, or on an attribute path', async () => {
    write('app.ts', `export class Conn {
  query(q: string) { return q; }
  run() { return this.query('1'); }
}
export function read(w: { c: Conn }) {
  return w.c.query('1');
}
`);
    const s = await indexed();

    const rows = s.db.prepare(
      `SELECT field_key FROM edges WHERE kind = 'call' AND dst_bare = 'query'`).all();
    // `this.query()` is answered by the self-call rule, and `w.c.query()` is written
    // on an attribute — neither is a call on a plain bound name.
    expect(rows.every((r) => r.field_key === null)).toBe(true);

    s.close();
  }, 30000);

  it('keys the inner binding when two scopes bind one name', async () => {
    write('app.ts', `export class Conn {
  query(q: string) { return q; }
}
export function outer(c: Conn) {
  function inner(c: Conn) {
    return c.query('inner');
  }
  return inner(c) + c.query('outer');
}
`);
    const s = await indexed();

    const rows = s.db.prepare(
      `SELECT line, field_key FROM edges WHERE kind = 'call' AND dst_bare = 'query' ORDER BY line`).all();
    expect(rows).toHaveLength(2);
    // Two different bindings of `c`, so two different keys.
    expect(rows[0].field_key).not.toBe(rows[1].field_key);

    s.close();
  }, 30000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-graph/tools/__tests__/ts-var-types.test.ts`
Expected: FAIL — the first test reports `expected null to match /#var:c@/`, because nothing keys a TypeScript call today.

- [ ] **Step 3: Capture TypeScript parameters and variable declarators**

Add to the end of `plugins/p-graph/tools/lib/parse/lang/ts.scm`:

```scheme
;; Names a TypeScript/JavaScript scope binds to a value. A call written on one of
;; these can only be resolved once we know what the name holds, so the binding has
;; to be recorded even when its type is not — see the driver, which keys the call on
;; the binding and lets the resolver decide.
;; The whole declaration is captured, not just its name: a type annotation and an
;; initialiser both hang off it, and Task 2 reads them from the same node.
(required_parameter (identifier) @var.decl)
(optional_parameter (identifier) @var.decl)
(formal_parameters (identifier) @var.decl)
(variable_declarator name: (identifier) @var.decl)
;; `x => x.foo()` writes its one parameter without brackets, so it is a direct child
;; of the arrow function rather than a formal_parameters list.
(arrow_function parameter: (identifier) @var.decl)
```

- [ ] **Step 4: Add the TypeScript scope set and the binding map**

In `plugins/p-graph/tools/lib/parse/driver.mjs`, next to `PY_SCOPE_NODES` (search for `const PY_SCOPE_NODES`), add:

```js
// The TypeScript/JavaScript nodes that open a scope. `let` and `const` are
// block-scoped, so a plain block counts; a function's parameters belong to the
// function. Missing a node type here makes a scope too WIDE, which keeps today's
// answer instead of inventing one — the same trade the Go set makes.
const TS_SCOPE_NODES = new Set([
  'statement_block', 'function_declaration', 'function_expression', 'arrow_function',
  'method_definition', 'class_body', 'for_statement', 'for_in_statement',
  'catch_clause', 'switch_case', 'switch_default', 'program',
]);
```

Then, next to the Python binding block (search for `const pyVarKeys = new Map()`), add the TypeScript one:

```js
  // The same idea as the Python and Go binding maps: one entry per name per scope,
  // so a call written on a name can be keyed and looked up later. The position is
  // part of the key because one function can bind one name in several scopes.
  const tsVarKeys = new Map(); // name -> [{ key, span }, ...]
  if (lang === 'ts' || lang === 'js') {
    for (const c of caps) {
      if (c.name !== 'var.decl') continue;
      let scope = c.node?.parent;
      while (scope && !TS_SCOPE_NODES.has(scope.type)) scope = scope.parent;
      if (!scope) continue;
      const owner = defs.filter((d) => within(c, d)).sort(innermostFirst)[0];
      const at = `@${c.node.startPosition.row + 1}:${c.node.startPosition.column}`;
      const key = owner ? `${owner.id}#var:${c.text}${at}` : `${file}#var:${c.text}${at}`;
      if (!tsVarKeys.has(c.text)) tsVarKeys.set(c.text, []);
      tsVarKeys.get(c.text).push({
        key,
        node: c.node,
        span: {
          startLine: scope.startPosition.row + 1, startCol: scope.startPosition.column,
          endLine: scope.endPosition.row + 1, endCol: scope.endPosition.column,
        },
      });
    }
  }
  // The binding in scope at this point, innermost first: of two scopes that both
  // hold one position, the inner one always starts later.
  const tsBindingAt = (name, node) => {
    const line = node.startPosition.row + 1, col = node.startPosition.column;
    const hits = (tsVarKeys.get(name) ?? []).filter((b) =>
      posLE(b.span.startLine, b.span.startCol, line, col) &&
      posLE(line, col, b.span.endLine, b.span.endCol));
    hits.sort((a, b) => b.span.startLine - a.span.startLine || b.span.startCol - a.span.startCol);
    return hits[0] ?? null;
  };
  const tsVarKeyAt = (name, node) => tsBindingAt(name, node)?.key ?? null;
```

- [ ] **Step 5: Key a member call written on a bound name**

In the same file, find the non-Go call branch (search for `const owner = selfCallOwner(c, lang, defs, enclosing);`). It already has a Python arm. Add the TypeScript arm right after it:

```js
        // `c.query(...)` in TypeScript: key the call on the receiver name, exactly
        // as Go keys `db.Get()` and Python keys `jar.set()`. With a type recorded
        // for that name the resolver answers it; with none, nothing changes.
        else if ((lang === 'ts' || lang === 'js') && c.node?.parent?.type === 'member_expression') {
          const obj = c.node.parent.childForFieldName?.('object');
          if (obj?.type === 'identifier') {
            const key = tsVarKeyAt(obj.text, obj);
            if (key) { field_key = key; method = c.text; }
          }
        }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run plugins/p-graph/tools/__tests__/ts-var-types.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Run the whole p-graph suite**

Run: `npx vitest run plugins/p-graph`
Expected: PASS. A key with no type row changes no answer, so no existing test may move. If one does, read it before changing it — it is telling you a call that used to resolve now does not.

- [ ] **Step 8: Check that no answer moved on a real repo**

```bash
node plugins/p-graph/scripts/measure.mjs --no-clone --repos got,nest
```

Expected: the same `resolved / published` and `certain / guess` numbers as before this task (got `setHeader` 91 / 2 certain / 89 guess; nest `createNestApplication` 190 / 0 / 190), and exit code 0.

- [ ] **Step 9: Commit**

```bash
git add plugins/p-graph/tools/lib/parse/lang/ts.scm plugins/p-graph/tools/lib/parse/driver.mjs plugins/p-graph/tools/__tests__/ts-var-types.test.ts
git commit -m "feat(p-graph): bind TypeScript names, and key a call written on one"
```

---

### Task 2: Read the type TypeScript states

**Files:**
- Modify: `plugins/p-graph/tools/lib/parse/driver.mjs` (a type reader, and rows for annotated bindings)
- Test: `plugins/p-graph/tools/__tests__/ts-var-types.test.ts` (extend)

**Interfaces:**
- Consumes: `tsVarKeys` and its `{ key, node }` entries from Task 1.
- Produces: `field_types` rows keyed by a Task 1 key, whose `type` is a class or interface name as written in the source (`Conn`), or a `#ret:<callee>` marker for a `new X()` initialiser.

- [ ] **Step 1: Write the failing test**

Append to `plugins/p-graph/tools/__tests__/ts-var-types.test.ts`:

```ts
describe('a TypeScript type stated in the source', () => {
  it('resolves a call on an annotated parameter, and calls it certain', async () => {
    write('app.ts', `export class Conn {
  query(q: string) { return q; }
}
export class Decoy {
  query(q: string) { return q; }
}
export function read(c: Conn) {
  return c.query('1');
}
`);
    const s = await indexed();

    // Two classes share the method name, so a bare name cannot answer this at all.
    expect(s.callers('Conn.query')).toMatchObject([{ qname: 'read', guess: 0 }]);
    expect(s.callers('Decoy.query')).toEqual([]);

    s.close();
  }, 30000);

  it('resolves a call on an annotated variable and on a new expression', async () => {
    write('app.ts', `export class Conn {
  query(q: string) { return q; }
}
export function fromAnnotation() {
  const c: Conn = build();
  return c.query('1');
}
export function fromNew() {
  const c = new Conn();
  return c.query('1');
}
function build(): any { return null; }
`);
    const s = await indexed();

    expect(s.callers('Conn.query').map((r) => r.qname).sort())
      .toEqual(['fromAnnotation', 'fromNew']);
    expect(s.callers('Conn.query').every((r) => r.guess === 0)).toBe(true);

    s.close();
  }, 30000);

  it('refuses a guess when the annotation names a type from outside the repo', async () => {
    write('app.ts', `import { ServerResponse } from 'node:http';
export class Sink {
  setHeader(k: string, v: string) {}
}
export function send(res: ServerResponse) {
  res.setHeader('a', 'b');
}
`);
    const s = await indexed();

    // ServerResponse is not ours, so the one repo method named setHeader must not
    // claim the call...
    expect(s.callers('Sink.setHeader')).toEqual([]);
    // ...and the call site is named instead of dropped.
    expect(s.gapsFor('Sink.setHeader').length).toBeGreaterThan(0);

    s.close();
  }, 30000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-graph/tools/__tests__/ts-var-types.test.ts`
Expected: FAIL — the first new test reports `expected [] to match object [ { qname: 'read', guess: +0 } ]`. With two classes named `query` the bare-name fallback refuses, and no type is recorded yet.

- [ ] **Step 3: Write the type reader**

In `plugins/p-graph/tools/lib/parse/driver.mjs`, next to `goFieldTypeName` (search for `function goFieldTypeName`), add:

```js
// The type a TypeScript declaration states, as written. A TS qname carries no
// package or module prefix — a top-level class `Conn` has the qname `Conn` — so the
// name as written is already the qname to look up, and no qualification is needed.
//
// Returns null for every shape a method call cannot be resolved through: a union, a
// function type, an array, a literal, `any`. A row is only worth writing when it
// names ONE type, because that is what the resolver's guards require.
function tsStatedTypeName(declNode) {
  const ann = declNode?.childForFieldName?.('type');          // `c: Conn`
  const t = ann?.type === 'type_annotation' ? ann.namedChild(0) : ann;
  if (t) {
    // `Conn`, and `Conn | null` is deliberately not one type.
    if (t.type === 'type_identifier') return t.text;
    // `foo.Bar` — a namespace-qualified type. TS qnames are dotted the same way.
    if (t.type === 'nested_type_identifier') return t.text.replace(/\s/g, '');
    // `Conn<T>`: the generic arguments do not change which class owns the method.
    if (t.type === 'generic_type') {
      const base = t.childForFieldName?.('name');
      if (base?.type === 'type_identifier') return base.text;
      if (base?.type === 'nested_type_identifier') return base.text.replace(/\s/g, '');
    }
    return null;
  }
  // `const c = new Conn()`. The initialiser names the type outright, which is the
  // same fact Go reads from `x := &T{}`.
  const value = declNode?.childForFieldName?.('value');
  if (value?.type === 'new_expression') {
    const ctor = value.childForFieldName?.('constructor');
    if (ctor?.type === 'identifier') return ctor.text;
  }
  return null;
}
```

- [ ] **Step 4: Write a row for every binding whose type is stated**

In the TypeScript binding block added in Task 1, after the loop that fills `tsVarKeys`, add:

```js
    // A stated type goes in the same table as Go's and Python's, so the SAME
    // resolver passes answer it: Pass F links `<type>.<method>`, and Pass B refuses
    // the bare-name fallback when a type is recorded but leads nowhere — which is
    // what an imported type from outside the repo does.
    for (const [, binds] of tsVarKeys) {
      for (const b of binds) {
        // The declaration is the parameter or the declarator, not the name node.
        const decl = b.node.parent;
        const type = tsStatedTypeName(decl);
        if (type) fieldTypes.push({ key: b.key, type, file });
      }
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run plugins/p-graph/tools/__tests__/ts-var-types.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run the whole p-graph suite**

Run: `npx vitest run plugins/p-graph`
Expected: PASS. Any moved test is a real signal: a call that resolved by bare name may now be refused because a type is recorded. Read the fixture before touching it, and if the new behaviour is right, update the assertion and say so in the commit message.

- [ ] **Step 7: Measure both directions on real repositories**

```bash
node plugins/p-graph/scripts/measure.mjs --no-clone --repos got,nest,flask,requests
```

Write down, for got `setHeader` and nest `createNestApplication`: resolved, certain, guess, gap rows. Expected direction: certain rows rise where annotations exist; nest's 190 must NOT fall, because `module` has no annotation and no `new`. If any symbol loses rows, find them before continuing:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('<work>/got/.pgraph/graph.db');for(const r of db.prepare(\"SELECT file,line,dst_name FROM edges WHERE kind='call' AND dst_id IS NULL AND dst_bare='setHeader'\").all())console.log(r.file+':'+r.line)"
```

- [ ] **Step 8: Commit**

```bash
git add plugins/p-graph/tools/lib/parse/driver.mjs plugins/p-graph/tools/__tests__/ts-var-types.test.ts
git commit -m "feat(p-graph): read the type a TypeScript declaration states"
```

---

### Task 3: Refuse a member call on an unannotated TypeScript parameter

**Files:**
- Modify: `plugins/p-graph/tools/lib/parse/driver.mjs` (one marker row)
- Test: `plugins/p-graph/tools/__tests__/ts-var-types.test.ts` (extend)

**Interfaces:**
- Consumes: `tsVarKeys` from Task 1, `tsStatedTypeName` from Task 2.
- Produces: a `field_types` row `{ key, type: '#param' }` for a `.ts` parameter with no annotation. `#param` is a marker like `#ret:` — no node can carry it as a qname, so nothing resolves through it, and Pass B's existing guard refuses.

- [ ] **Step 1: Write the failing test**

Append to `plugins/p-graph/tools/__tests__/ts-var-types.test.ts`:

```ts
describe('an unannotated TypeScript parameter', () => {
  it('refuses the bare-name guess, and reports the call site', async () => {
    write('lib.ts', `export class Sink {
  setHeader(k: string, v: string) {}
}
`);
    write('test.ts', `import { serve } from 'some-library';
export function run() {
  serve('/x', (request, response) => {
    response.setHeader('a', 'b');
  });
}
`);
    const s = await indexed();

    // `response` is typed by the library's own signature, which is not in this
    // repo. got printed 89 rows of exactly this shape, all of them wrong.
    expect(s.callers('Sink.setHeader')).toEqual([]);
    expect(s.gapsFor('Sink.setHeader').length).toBeGreaterThan(0);

    s.close();
  }, 30000);

  it('leaves JavaScript alone, where nothing is ever annotated', async () => {
    write('lib.js', `export class Sink {
  setHeader(k, v) {}
}
`);
    write('use.js', `import { serve } from 'some-library';
export function run() {
  serve('/x', (request, response) => {
    response.setHeader('a', 'b');
  });
}
`);
    const s = await indexed();

    // Refusing here would gut JavaScript: no parameter carries a type, so every
    // member call on one would be refused. The row stays, marked a guess.
    expect(s.callers('Sink.setHeader')).toMatchObject([{ guess: 1 }]);

    s.close();
  }, 30000);

  it('still resolves a call on an annotated parameter in the same file', async () => {
    write('app.ts', `export class Conn {
  query(q: string) { return q; }
}
export function read(c: Conn, other) {
  return c.query('1');
}
`);
    const s = await indexed();

    // One parameter is annotated and one is not; only the unannotated one is
    // affected, so this call must still be certain.
    expect(s.callers('Conn.query')).toMatchObject([{ qname: 'read', guess: 0 }]);

    s.close();
  }, 30000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-graph/tools/__tests__/ts-var-types.test.ts`
Expected: FAIL — the first new test reports a caller row where it expects none.

- [ ] **Step 3: Record the marker**

In the loop added in Task 2's Step 4, replace the body with:

```js
    for (const [, binds] of tsVarKeys) {
      for (const b of binds) {
        const decl = b.node.parent;
        const type = tsStatedTypeName(decl);
        if (type) { fieldTypes.push({ key: b.key, type, file }); continue; }
        // No type stated. In TypeScript that means one of two things, and both make
        // a bare-name guess wrong: the parameter is typed by the signature it is
        // passed to (a library callback — got's 89 false rows), or the file compiles
        // under implicit-any, where nothing can be said either. Record that the type
        // is decided elsewhere; the resolver refuses rather than guesses.
        //
        // Parameters only, and `.ts` only. A `const`/`let` with no annotation takes
        // its type from an initialiser this rule cannot read (nest's `const module =
        // await Test.createTestingModule(...).compile()`), and refusing there would
        // throw away 190 correct rows on nestjs/nest. JavaScript annotates nothing
        // at all, so the rule would refuse every member call in a .js file.
        const isParam = decl?.type === 'required_parameter' || decl?.type === 'optional_parameter' ||
          decl?.parent?.type === 'formal_parameters';
        if (lang === 'ts' && isParam) fieldTypes.push({ key: b.key, type: '#param', file });
      }
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run plugins/p-graph/tools/__tests__/ts-var-types.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the whole p-graph suite**

Run: `npx vitest run plugins/p-graph`
Expected: PASS.

- [ ] **Step 6: Measure the recall cost, which is the point of this task**

```bash
node plugins/p-graph/scripts/measure.mjs --no-clone
```

Record for every symbol: resolved, certain, guess. Then read what was refused on got and on nest:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('<work>/nest/.pgraph/graph.db');console.log(db.prepare(\"SELECT count(*) c FROM edges WHERE kind='call' AND dst_id IS NULL AND field_key LIKE '%#var:%'\").get().c)"
```

Pass condition, all three:
- got `setHeader` guessed rows drop from 89 to 0, and its gap rows rise by about the same number.
- nest `createNestApplication` still reports 190 rows.
- `measure.mjs` exits 0.

If nest drops, the parameter test in Step 3 is matching a variable declarator — print `decl.type` for the failing binding and fix the check.

- [ ] **Step 7: Sample twenty refused rows and read them**

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('<work>/got/.pgraph/graph.db');const rows=db.prepare(\"SELECT file,line,dst_name FROM edges WHERE kind='call' AND dst_id IS NULL AND field_key LIKE '%#var:%' LIMIT 400\").all();for(let i=0;i<rows.length;i+=20)console.log(rows[i].file+':'+rows[i].line+' -> '+rows[i].dst_name)"
```

Open each and write down whether the refused call really did target a repo symbol. A refusal that removes a correct row is a recall cost and belongs in the commit message and in the results table. Do not skip this step: the equivalent sample is what caught a 2,972-row mistake in the Go work.

- [ ] **Step 8: Commit**

```bash
git add plugins/p-graph/tools/lib/parse/driver.mjs plugins/p-graph/tools/__tests__/ts-var-types.test.ts
git commit -m "fix(p-graph): refuse a member call on an unannotated TypeScript parameter"
```

---

### Task 4: Publish the numbers and release

**Files:**
- Modify: `plugins/p-graph/README.md` (the certainty list and the false-row table)
- Modify: `plugins/p-graph/scripts/measure.mjs` (an audit reason for a stated TypeScript type)
- Modify: `plugins/p-graph/docs/superpowers/plans/2026-08-04-p-graph-follow-up.md` (move item 1 to the fixed section)
- Modify: `plugins/p-graph/.claude-plugin/plugin.json` (version)

**Interfaces:**
- Consumes: the measured numbers from Task 3, Step 6.
- Produces: nothing other tasks rely on.

- [ ] **Step 1: Add the audit reason**

`measure.mjs` checks every certain row against a fact read from the source. A row resolved through a TypeScript annotation has none of the six existing reasons, so the script will fail with unexplained rows until this is added. In the `REASONS` array add:

```js
  'the source annotates the receiver with the target\'s own class (TypeScript)',
```

and in the reason chain, next to the constructor check, add:

```js
          || Boolean(qualified && e.lang === 'ts' && e.dst.includes('.')
                    && annotatedIn(e.file, qualified[1], e.dst))
```

with this helper next to `ownerAssignedIn`:

```js
    // Does this file annotate `recv` with the class that owns `dstQname`? A text
    // search on purpose: it reads the SOURCE, so it can disagree with the graph.
    const annotatedIn = (file, recv, dstQname) => {
      const owner = dstQname.slice(0, dstQname.lastIndexOf('.')).split('.').pop();
      if (!owner) return false;
      const head = recv.split('.')[0];
      return new RegExp(`\\b${head}\\s*:\\s*[\\w.<>\\[\\]| ]*\\b${owner}\\b`).test(srcOf(file))
        || new RegExp(`\\b${head}\\s*=\\s*new\\s+${owner}\\s*\\(`).test(srcOf(file));
    };
```

- [ ] **Step 2: Run the script and require exit 0**

Run: `node plugins/p-graph/scripts/measure.mjs --no-clone`
Expected: `Every certain row is explained. None is false.` and exit code 0. If rows are still unexplained, read them — either the reason is too narrow or a resolved row is genuinely wrong.

- [ ] **Step 3: Update the README**

In the "Certain" list, after the Python entry, add:

```markdown
- **a TypeScript declaration states the type.** `function read(c: Conn)` or `const c = new Conn()`, then `c.query(...)`. A parameter with **no** annotation in a `.ts` file records the opposite fact — its type comes from the signature it is passed to, which is usually a library's — so the call is refused and reported instead of guessed.
```

Then replace the false-row table's "now" rows with the numbers from Task 3, Step 6, and replace the paragraph under it with one sentence per change, each with its measured figure. Keep the sentence that explains what "at most" means.

- [ ] **Step 4: Move follow-up item 1 to the fixed section**

Delete `### 1. A type table for TypeScript` from the numbered list, renumber the items after it, and add to "Fixed after this list was written" a section with: the measured shape of got's 89 rows, the rule that removed them, the table from Task 3 Step 6, the recall cost from Task 3 Step 7, and the nest 190 rows as a stated non-goal with its four missing facts.

- [ ] **Step 5: Run everything, on both platforms**

```bash
npx vitest run
wsl -e bash -lc 'cd ~/pgraph && npx vitest run plugins/p-graph'
```

Expected: green on both. Report both numbers — a Windows-only run proves nothing about the platform these plugins run on.

- [ ] **Step 6: Propose the release and wait**

`plugin.json` goes to the next minor (`1.1.0` → `1.2.0` if 1.1.0 has shipped, otherwise stay on 1.1.0 and say so). The monorepo tag is the next free one — check `git tag --sort=-v:refname | head -3` first, because another session may have taken it.

Say the proposed tag and per-plugin bump with reasoning, then **stop and wait for an explicit yes**. Never tag or push without one.

- [ ] **Step 7: Commit**

```bash
git add plugins/p-graph/README.md plugins/p-graph/scripts/measure.mjs plugins/p-graph/docs/superpowers/plans/2026-08-04-p-graph-follow-up.md plugins/p-graph/.claude-plugin/plugin.json
git commit -m "docs(p-graph): publish the TypeScript type numbers"
```

---

## What this plan does not do

Written down so it is not rediscovered as a bug:

- **nest's 190 correct-but-guessed rows stay guesses.** They need a monorepo package name mapped to a directory, a class resolved through that import, result types for TypeScript methods, and a chain through two calls and an `await`.
- **A receiver written as an attribute** (`self.ready.set()`, `w.c.query()`) is not keyed in any language. Nothing records what an attribute holds outside Go's struct-field table.
- **Go's multi-value `:=`** (`seqv, isNil := hreflect.Indirect(seqv)`) still records no type — 11 false rows on hugo. Positional result types would close it.
- **C++ free functions** called by bare name stay guesses — 8 correct-but-guessed rows on leveldb.
