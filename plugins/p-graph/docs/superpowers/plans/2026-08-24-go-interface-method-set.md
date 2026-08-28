# Go interface method sets, and `callers` on an interface method — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `callers` on a Go interface method also reports the call sites that run an implementation of it, and every method a Go interface declares becomes a node instead of only the first one.

**Architecture:** Three changes, each independently testable. The tree-sitter query anchors the interface-method definition on the `method_spec` rather than the whole `interface_type`, so each method gets its own span, line and signature. A new pure module turns a stored signature line into a shape (parameter count, does it declare a result) so interface satisfaction is not decided on the method name alone. A new store query mirrors the existing `interfaceReach` in the other direction and the CLI prints it under its own heading.

**Tech Stack:** Node ≥ 22.5 (`node:sqlite`, no npm deps), web-tree-sitter with vendored WASM grammars, vitest.

## Global Constraints

- **The plugin's runtime floor is Node 22.5.** Do not use an API newer than that in `tools/`.
- **The test suite needs Node 24+, and on a Windows host the run that counts is under WSL.** Command: `wsl -e bash -lc 'export PATH=$HOME/.local/node24/bin:$PATH && cd ~/pshed && npx vitest run'`. Report both platforms when both were run, and say which one is WSL.
- **All artifacts in English, in Simple English.** Short sentences, everyday words.
- **No Claude attribution in commit messages.** No `Co-Authored-By`, no "Generated with".
- **Never move a published number silently.** `docs/measured-benefit.md` and both READMEs carry measured figures. This change alters what the p-graph arm answers, so Task 4 ends by asking the user about a re-measurement — it does not start one.
- **`SCHEMA_VERSION` must be bumped when stored rows change.** It is 11 today. Task 1 makes new nodes appear and changes the `signature` of existing ones, so an incremental reindex would answer differently from a full one. That is exactly what the bump exists to prevent.

---

## Why this work exists — the facts behind it

Measured on the `caddy` clone at commit `e096ca9` with the graph built by this repo's own `pgraph index --full`:

1. **A Go interface with more than one method keeps only its first method.** caddy declares 66 Go interfaces; 13 of them declare more than one method; those 13 declare 31 methods and the graph holds 13. **18 method nodes are missing.** `caddyhttp.ResponseRecorder` declares 5 and has 1. The cause is in `tools/lib/parse/lang/go.scm:31`, where `@definition.method` is anchored on the enclosing `(interface_type …)`. Every `method_spec` in one interface therefore shares one span, and the driver's span dedup (`tools/lib/parse/driver.mjs:1333-1346`) keeps one of them.

2. **An interface method's own signature is not stored.** Because the span is the `interface_type`, `signature` is taken from the interface's declaration line:

   | qname | stored signature |
   |---|---|
   | `caddyhttp.Handler.ServeHTTP` | `type Handler interface {` |
   | `caddyhttp.MiddlewareHandler.ServeHTTP` | `type MiddlewareHandler interface {` |
   | `caddyhttp.metricsInstrumentedRoute.ServeHTTP` | `func (h *metricsInstrumentedRoute) ServeHTTP(w http.ResponseWriter, r *http.Request) error {` |

   A concrete method carries its real signature. An interface method does not, so the two cannot be compared today.

3. **`callers` on an interface method cannot reach the implementations.** In `modules/caddyhttp/metrics_test.go` there are 18 call sites written `ih.ServeHTTP(w, r)`, where `ih := newMetricsInstrumentedRoute(…)`. The graph resolves **all 18 certainly** (`guess 0`): 17 land on `caddyhttp.metricsInstrumentedRoute.ServeHTTP` and one on `caddyhttp.Handler.ServeHTTP`, because there the receiver is typed as the interface. Asked for `callers caddyhttp.Handler.ServeHTTP`, the graph names 1 of the 18 — the resolution is right, the question's shape is what is unanswered. In the study's measurement that is 16 of the 17 sites Go loses, and Go's list-question recall is 229/279 (82.1%) against grep's 277/279.

4. **The name alone does not identify the contract.** caddy holds 34 methods named `ServeHTTP`. The question the study asks excludes two of the shapes by hand: the three-parameter `MiddlewareHandler.ServeHTTP`, and the standard library's `http.Handler` form that returns nothing (`caddyhttp.Server.ServeHTTP`). So the new direction must compare shapes, not names. Parameter count plus "does it declare a result" separates exactly those three cases.

5. **The other direction already exists.** `interfaceReach` in `tools/lib/destinations/local-sqlite.mjs:1770` answers the mirror question — asked about an implementation, it lists calls that arrive through the interface — and `tools/lib/cli/commands.mjs:222-234` prints them under their own heading. It decides satisfaction on method **names** only, and it reads the interface's method set with `SELECT name FROM nodes WHERE container_id = ?`. Task 1 therefore also makes that existing feature more precise: today it compares against a set of one name where the interface declares five.

## File Structure

| File | Responsibility |
|---|---|
| `tools/lib/parse/lang/go.scm` | **Modify.** Anchor the interface-method definition on `method_spec`. |
| `tools/lib/sig-shape.mjs` | **Create.** One pure function: a signature line and a name in, `{ params, hasResult }` out. No I/O, no database. |
| `tools/lib/destinations/local-sqlite.mjs` | **Modify.** Bump `SCHEMA_VERSION` to 12. Use the shape in the existing satisfaction check. Add `implementationReach`, the mirror of `interfaceReach`, and feed it into `gapsFor`. |
| `tools/lib/cli/commands.mjs` | **Modify.** A fourth partition in `gapCounts` and a heading for it. |
| `tools/__tests__/lang-go-interface-methods.test.ts` | **Create.** Extraction: every method of a multi-method interface, with its own line and signature. |
| `tools/__tests__/sig-shape.test.ts` | **Create.** Unit tests for the shape reader, including caddy's three real `ServeHTTP` lines. |
| `tools/__tests__/cli-implementation-reach.test.ts` | **Create.** End-to-end: `callers` on an interface method lists the implementation's call sites under the new heading, and refuses a same-named method of a different shape. |

---

### Task 1: Every method a Go interface declares becomes its own node

**Files:**
- Modify: `plugins/p-graph/tools/lib/parse/lang/go.scm:31`
- Modify: `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs:36-66` (the schema-version comment block and the constant)
- Test: `plugins/p-graph/tools/__tests__/lang-go-interface-methods.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: node rows for interface methods where `signature` is the method's own source line (for example `Get(key string) ([]byte, error)`), `start_line` is the method's own line, and `container_id` still points at the interface node. Task 2 and Task 3 both rely on that signature being the method's own line.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-graph/tools/__tests__/lang-go-interface-methods.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveLang } from '../lib/parse/index.mjs';
import { extract } from '../lib/parse/driver.mjs';

// Three methods in one interface, and one of them shares a name with a method on
// a concrete type. Both facts matter: the three must not collapse into one, and
// the interface's own methods must stay nested under the interface.
const SRC = `package store
type Store interface {
	Get(key string) ([]byte, error)
	Put(key string, value []byte) error
	Close() error
}
type File struct{}
func (f *File) Close() error { return nil }
`;

async function run(src = SRC) {
  const cfg = resolveLang('store.go');
  return extract({ file: 'store.go', lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source: src });
}

describe('go interface method sets', () => {
  it('records every method the interface declares, not only the first', async () => {
    const { nodes } = await run();
    const iface = nodes.find((n) => n.name === 'Store' && n.kind === 'interface');
    expect(iface).toBeTruthy();
    const members = nodes.filter((n) => n.container_id === iface.id).map((n) => n.name).sort();
    expect(members).toEqual(['Close', 'Get', 'Put']);
  }, 20000);

  it('gives each one its own line and its own signature', async () => {
    const { nodes } = await run();
    const iface = nodes.find((n) => n.name === 'Store' && n.kind === 'interface');
    const member = (name) => nodes.find((n) => n.container_id === iface.id && n.name === name);
    expect(member('Get').start_line).toBe(3);
    expect(member('Put').start_line).toBe(4);
    expect(member('Close').start_line).toBe(5);
    expect(member('Get').signature).toBe('Get(key string) ([]byte, error)');
    expect(member('Put').signature).toBe('Put(key string, value []byte) error');
    // The interface's own line must no longer be handed to its methods.
    expect(member('Get').signature).not.toContain('interface {');
  }, 20000);

  it('keeps the concrete method separate from the interface method of the same name', async () => {
    const { nodes } = await run();
    const closes = nodes.filter((n) => n.name === 'Close');
    expect(closes).toHaveLength(2);
    expect(closes.map((n) => n.qname).sort()).toEqual(['store.File.Close', 'store.Store.Close']);
  }, 20000);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run plugins/p-graph/tools/__tests__/lang-go-interface-methods.test.ts`

Expected: the first test fails with `expected [ 'Get' ] to deeply equal [ 'Close', 'Get', 'Put' ]`. The second fails on `start_line` being 2 for all three.

- [ ] **Step 3: Move the capture onto the method_spec**

In `plugins/p-graph/tools/lib/parse/lang/go.scm`, replace line 31 and extend the comment above it:

```scheme
; `method_spec` only ever appears in an interface body; an EMBEDDED interface is a
; constraint_elem, not a method_spec, so it stays out on its own.
; The definition is anchored on the METHOD_SPEC, not on the interface_type around
; it. Anchoring outside was measured wrong twice over: every method_spec in one
; interface then shares the interface's span, so the driver's span dedup keeps one
; of them (13 caddy interfaces declared 31 methods and the graph held 13), and the
; signature line handed to each method was `type X interface {` instead of the
; method's own declaration.
(interface_type (method_spec name: (field_identifier) @name) @definition.method)
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run plugins/p-graph/tools/__tests__/lang-go-interface-methods.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 5: Run every Go and interface test, because this changes what is stored**

Run: `npx vitest run plugins/p-graph/tools/__tests__/lang-go.test.ts plugins/p-graph/tools/__tests__/driver-go-fields.test.ts plugins/p-graph/tools/__tests__/driver-go-grouped.test.ts plugins/p-graph/tools/__tests__/driver-nesting.test.ts plugins/p-graph/tools/__tests__/interface-reach.test.ts plugins/p-graph/tools/__tests__/cli-interface-reach.test.ts`

Expected: PASS. If `interface-reach.test.ts` now fails, read it before touching it: its fixture may have been written against the one-method-only behaviour, in which case the fixture is the thing that was wrong.

- [ ] **Step 6: Bump the schema version**

In `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs`, add to the comment block that ends at line 65 and change the constant:

```javascript
// 12: every method a Go interface declares is a node, not just the first one, and
// an interface method's `signature` is now its own source line instead of the
// interface's. Both change what an answer says: a call written on a multi-method
// interface used to land on nothing, and the method set used to decide "does this
// type implement that interface" was short — one name where the interface declares
// five, which made the interface-reach group over-report. An incremental reindex
// would hold the new rows for the files it reparsed and the old ones everywhere
// else, so the two would be read side by side. Rebuild whole.
export const SCHEMA_VERSION = 12;
```

- [ ] **Step 7: Run the store tests**

Run: `npx vitest run plugins/p-graph/tools/__tests__/store-write.test.ts plugins/p-graph/tools/__tests__/store-read.test.ts plugins/p-graph/tools/__tests__/cli-index-status.test.ts plugins/p-graph/tools/__tests__/resolve-idempotent.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add plugins/p-graph/tools/lib/parse/lang/go.scm plugins/p-graph/tools/lib/destinations/local-sqlite.mjs plugins/p-graph/tools/__tests__/lang-go-interface-methods.test.ts
git commit -m "fix(p-graph): record every method a Go interface declares, not only the first"
```

---

### Task 2: Read a callable's shape from the one line the graph stores

**Files:**
- Create: `plugins/p-graph/tools/lib/sig-shape.mjs`
- Test: `plugins/p-graph/tools/__tests__/sig-shape.test.ts`

**Interfaces:**
- Consumes: the signature lines Task 1 makes available on interface methods.
- Produces: `export function sigShape(signature, name)` returning `{ params: number, hasResult: boolean }`, or `null` when the line does not hold a parameter list for that name. Task 3 calls it with `(node.signature, node.name)`.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-graph/tools/__tests__/sig-shape.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { sigShape } from '../lib/sig-shape.mjs';

describe('sigShape', () => {
  it('reads a Go interface method line', () => {
    expect(sigShape('ServeHTTP(http.ResponseWriter, *http.Request) error', 'ServeHTTP'))
      .toEqual({ params: 2, hasResult: true });
  });

  it('reads a Go method declaration and skips the receiver group', () => {
    expect(sigShape('func (h *metricsInstrumentedRoute) ServeHTTP(w http.ResponseWriter, r *http.Request) error {', 'ServeHTTP'))
      .toEqual({ params: 2, hasResult: true });
  });

  // The three real shapes this exists to tell apart, all from caddy.
  it('separates the three ServeHTTP contracts in caddy', () => {
    const iface = sigShape('ServeHTTP(http.ResponseWriter, *http.Request) error', 'ServeHTTP');
    const middleware = sigShape('ServeHTTP(http.ResponseWriter, *http.Request, Handler) error', 'ServeHTTP');
    const stdlib = sigShape('func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {', 'ServeHTTP');
    expect(iface).toEqual({ params: 2, hasResult: true });
    expect(middleware).toEqual({ params: 3, hasResult: true });
    expect(stdlib).toEqual({ params: 2, hasResult: false });
  });

  it('counts a nested parameter list as one parameter', () => {
    expect(sigShape('Walk(fn func(string, int) error) error', 'Walk'))
      .toEqual({ params: 1, hasResult: true });
  });

  it('counts a map or generic type as one parameter', () => {
    expect(sigShape('Set(m map[string]string, keys []string) error', 'Set'))
      .toEqual({ params: 2, hasResult: true });
  });

  it('reads a parenthesised result list as a result', () => {
    expect(sigShape('Get(key string) ([]byte, error)', 'Get'))
      .toEqual({ params: 1, hasResult: true });
  });

  it('reads no parameters and no result', () => {
    expect(sigShape('Reset()', 'Reset')).toEqual({ params: 0, hasResult: false });
  });

  it('returns null when the line holds no parameter list for that name', () => {
    expect(sigShape('type Handler interface {', 'ServeHTTP')).toBeNull();
    expect(sigShape('', 'ServeHTTP')).toBeNull();
    expect(sigShape(null, 'ServeHTTP')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run plugins/p-graph/tools/__tests__/sig-shape.test.ts`

Expected: FAIL — `Failed to resolve import "../lib/sig-shape.mjs"`.

- [ ] **Step 3: Write the module**

Create `plugins/p-graph/tools/lib/sig-shape.mjs`:

```javascript
// The shape of a callable, read from the single source line the graph stores as
// its `signature`: how many parameters it takes, and whether it declares a
// result. Nothing more. That is enough to tell apart the contracts a name alone
// cannot — caddy holds 34 methods called `ServeHTTP`, in three different shapes,
// and a question about one of them is not a question about the others.
//
// Deliberately not a type comparison. The same type is spelled differently on
// either side of a package boundary (`http.ResponseWriter` in one file,
// `ResponseWriter` in the file that declares it), so comparing type text would
// refuse honest matches. Parameter count and "is there a result" are written the
// same way everywhere.

// The paren group that starts at `from`, and where it ends. Depth-aware, so a
// parameter that is itself a function type stays one parameter.
function group(line, from) {
  if (line[from] !== '(') return null;
  let depth = 0;
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') {
      depth--;
      if (depth === 0) return { inner: line.slice(from + 1, i), end: i };
    }
  }
  return null;
}

// Top-level commas only, for the same reason.
function countParams(inner) {
  const text = inner.trim();
  if (!text) return 0;
  let depth = 0;
  let n = 1;
  for (const c of text) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) n++;
  }
  return n;
}

export function sigShape(signature, name) {
  const line = typeof signature === 'string' ? signature.trim() : '';
  if (!line || !name) return null;
  // The name may appear more than once on the line — a Go receiver can be named
  // after its own method in principle, and a result type can repeat it. Take the
  // first occurrence that is immediately followed by a parameter list.
  for (let at = line.indexOf(name); at !== -1; at = line.indexOf(name, at + 1)) {
    const after = at + name.length;
    // A longer identifier that merely contains `name` is not this method.
    if (/[\w$]/.test(line[after] ?? '')) continue;
    if (/[\w$.]/.test(line[at - 1] ?? '')) continue;
    const params = group(line, after);
    if (!params) continue;
    const rest = line.slice(params.end + 1).replace(/\{\s*$/, '').trim();
    return { params: countParams(params.inner), hasResult: rest.length > 0 };
  }
  return null;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run plugins/p-graph/tools/__tests__/sig-shape.test.ts`

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-graph/tools/lib/sig-shape.mjs plugins/p-graph/tools/__tests__/sig-shape.test.ts
git commit -m "feat(p-graph): read a callable's parameter count and result from its signature line"
```

---

### Task 3: `callers` on an interface method reports the calls that run an implementation

**Files:**
- Modify: `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs` (import `sigShape`; add `implementationReach` next to `interfaceReach` at line 1770; use the shape inside `interfaceReach`; call the new function from `store.gapsFor`)
- Modify: `plugins/p-graph/tools/lib/cli/commands.mjs:176-183` and `:218-234`
- Test: `plugins/p-graph/tools/__tests__/cli-implementation-reach.test.ts`

**Interfaces:**
- Consumes: `sigShape(signature, name)` from Task 2; interface-method signatures from Task 1; the existing `ownerOf(node)` helper, which returns `{ id, qname, kind, names }` for a method's owning type.
- Produces: gap rows shaped `{ file, line, dst_name, src_qname, reason: 'implementation', reachable: 1, via }` where `via` is the implementing method's qname. `commands.mjs` reads `reason === 'implementation'`.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-graph/tools/__tests__/cli-implementation-reach.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-graph/tools/pgraph.mjs');
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-implreach-'));
  mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
  const write = (rel, src) => {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, src);
  };
  // `Store` declares one method. `Postgres` implements it. `Cache` has a method
  // of the same name and a DIFFERENT shape — one parameter, no result — so it must
  // not be reported as an implementation.
  write('store/store.go', 'package store\ntype Store interface {\n\tListGroups() []string\n}\n');
  write('store/pg.go', 'package store\ntype Postgres struct{}\nfunc (p *Postgres) ListGroups() []string { return nil }\n');
  write('store/cache.go', 'package store\ntype Cache struct{}\nfunc (c *Cache) ListGroups(reset bool) { }\n');
  // A call on the concrete type, and a call on the differently shaped method.
  write('api/api.go', 'package api\nimport "x/store"\nfunc Serve() []string {\n\tpg := &store.Postgres{}\n\treturn pg.ListGroups()\n}\n');
  write('api/other.go', 'package api\nimport "x/store"\nfunc Warm() {\n\tc := &store.Cache{}\n\tc.ListGroups(true)\n}\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });

// Asked about the interface method, the calls that run an implementation are
// knowledge, not a gap: the graph knows which type the receiver is and which
// method that call runs. They get their own heading for the same reason the
// interface-reach group does — a reader must not confuse "accounted for" with
// "go and grep for this".
describe('callers on an interface method', () => {
  it('reports the calls that run an implementation, under their own heading', () => {
    run(['index', '--full']);

    const out = run(['callers', 'store.Store.ListGroups']);
    expect(out).toContain('run an implementation of this method');
    expect(out).toContain('store.Postgres.ListGroups');
    expect(out).toContain('api/api.go:5');
    expect(out).not.toContain('missing from this answer');
  }, 30000);

  it('refuses a same-named method whose shape is different', () => {
    run(['index', '--full']);

    const out = run(['callers', 'store.Store.ListGroups']);
    expect(out).not.toContain('store.Cache.ListGroups');
    expect(out).not.toContain('api/other.go');
  }, 30000);

  it('carries the rows in --json under their own reason', () => {
    run(['index', '--full']);

    const parsed = JSON.parse(run(['callers', 'store.Store.ListGroups', '--json']));
    const rows = (parsed.gaps ?? []).filter((r) => r.reason === 'implementation');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.via)).toContain('store.Postgres.ListGroups');
    expect(rows.map((r) => `${r.file}:${r.line}`)).toContain('api/api.go:5');
  }, 30000);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run plugins/p-graph/tools/__tests__/cli-implementation-reach.test.ts`

Expected: FAIL — the output does not contain `run an implementation of this method`.

- [ ] **Step 3: Import the shape reader and use it where satisfaction is decided**

In `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs`, add the import next to the other local imports at the top of the file:

```javascript
import { sigShape } from '../sig-shape.mjs';
```

- [ ] **Step 4: Add `implementationReach` after `interfaceReach`**

In the same file, immediately after the closing `};` of `interfaceReach` (line 1797 before this change), insert:

```javascript
  // The mirror of interfaceReach. Asked about a method an INTERFACE declares,
  // find the types that implement the interface and report the calls that land on
  // their method. Those calls resolve certainly — the receiver's type is written
  // at the call site — so they are knowledge the reader would otherwise have to
  // grep for.
  //
  // Measured on caddy: `callers caddyhttp.Handler.ServeHTTP` named 1 of the 18
  // calls in modules/caddyhttp/metrics_test.go. The other 17 resolve to
  // `metricsInstrumentedRoute.ServeHTTP`, which is the right answer to "which
  // method runs" and the wrong answer to the question that was asked.
  //
  // Satisfaction is the method set, the way Go decides it, PLUS the shape of the
  // method being asked about. The set alone is not enough here: caddy holds 34
  // methods named `ServeHTTP` in three shapes, and a question about the
  // two-parameter form that returns an error is not a question about the
  // three-parameter middleware form or about the standard library's form that
  // returns nothing.
  const implementationReach = (node) => {
    if (!node?.name || !node.container_id) return [];
    const iface = db.prepare('SELECT id, qname, kind FROM nodes WHERE id = ?').get(node.container_id);
    if (!iface || iface.kind !== 'interface') return [];
    const need = db.prepare('SELECT name FROM nodes WHERE container_id = ?').all(iface.id)
      .map((r) => r.name);
    if (!need.length) return []; // an empty interface is satisfied by everything
    const want = sigShape(node.signature, node.name);
    const rowsFor = db.prepare(`
      SELECT e.file, e.line, e.dst_name, s.qname AS src_qname
      FROM edges e LEFT JOIN nodes s ON s.id = e.src_id
      WHERE e.kind = 'call' AND e.dst_id = ? ORDER BY e.file, e.line`);
    const out = [];
    for (const cand of db.prepare(`
      SELECT id, qname, signature, name, lang, container_id FROM nodes
      WHERE name = ? AND lang = ? AND kind IN ('function','method') AND id <> ?`)
      .all(node.name, node.lang, node.id)) {
      const owner = ownerOf(cand);
      if (!owner || owner.kind === 'interface') continue;
      const ownNames = new Set(owner.names);
      if (!need.every((n) => ownNames.has(n))) continue;
      // Compared only when both sides state a shape. An interface method whose
      // signature could not be read must not silently widen the match.
      const got = sigShape(cand.signature, cand.name);
      if (!want || !got) continue;
      if (want.params !== got.params || want.hasResult !== got.hasResult) continue;
      for (const r of rowsFor.all(cand.id)) {
        out.push({ file: r.file, line: r.line, dst_name: r.dst_name, src_qname: r.src_qname,
          reason: 'implementation', reachable: 1, via: cand.qname });
      }
    }
    return out;
  };
```

- [ ] **Step 5: Feed it into the gap report**

In the same file, inside `store.gapsFor`, the existing loop adds `interfaceReach` rows and skips a file:line already present. The new rows need the same treatment, so lift that body into one local and call it for both — two copies of a dedup loop is the kind of thing that goes wrong once and then goes wrong twice:

```javascript
    const addOnce = (extra) => {
      for (const r of extra) {
        const key = `${r.file}|${r.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(r);
      }
    };
    for (const t of targets) {
      addOnce(interfaceReach(t));
      addOnce(implementationReach(t));
    }
```

- [ ] **Step 6: Give the rows their own partition and heading**

In `plugins/p-graph/tools/lib/cli/commands.mjs`, change `gapCounts` (line 176) to:

```javascript
  const gapCounts = (rows) => ({
    viaInterface: rows.filter((r) => r.reason === 'interface'),
    viaImplementation: rows.filter((r) => r.reason === 'implementation'),
    listed: rows.filter((r) => r.reason !== 'external' && r.reason !== 'interface'
      && r.reason !== 'implementation' && r.reason !== 'library' && r.reachable !== 0),
    unrelated: rows.filter((r) => r.reason === 'ambiguous' && r.reachable === 0).length,
    library: rows.filter((r) => r.reason === 'library').length,
    external: rows.filter((r) => r.reason === 'external').length,
  });
```

Then in `emitGaps`, destructure the new field and print it after the interface group:

```javascript
  const emitGaps = (rows, complete = false, line = COMPLETE) => {
    const { viaInterface, viaImplementation, listed, unrelated, library, external } = gapCounts(rows);
```

and immediately after the `if (viaInterface.length) { … }` block:

```javascript
    // The opposite direction, and it says something different: here the receiver's
    // type IS written at the call site, so the graph knows exactly which method
    // runs. Grouped by the implementing method so the reader can see which type
    // each call belongs to.
    if (viaImplementation.length) {
      const byImpl = new Map();
      for (const r of viaImplementation) {
        if (!byImpl.has(r.via)) byImpl.set(r.via, []);
        byImpl.get(r.via).push(r);
      }
      for (const [via, rs] of byImpl) {
        out(`ℹ ${rs.length} call site${rs.length === 1 ? '' : 's'} run an implementation of this method — ${via}:`);
        for (const r of rs.slice(0, GAP_LIMIT)) {
          out(`    ${r.file}:${r.line}  ${r.src_qname ?? 'file scope'} -> ${r.dst_name}`);
        }
        if (rs.length > GAP_LIMIT) out(`    … and ${rs.length - GAP_LIMIT} more`);
      }
    }
```

Also update `nothingMissing` so the new rows do not read as something missing — it already keys off `listed`, `unrelated`, `external` and `library`, so no change is needed there. Confirm by reading lines 184-187 rather than assuming.

- [ ] **Step 7: Run the test and watch it pass**

Run: `npx vitest run plugins/p-graph/tools/__tests__/cli-implementation-reach.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 8: Expect one existing test to need a new assertion, and know why before you touch it**

`tools/__tests__/cli-interface-reach.test.ts` ends with a test called *"leaves the interface method's own answer alone"*. Its fixture has one call, `st.ListGroups()` on a parameter typed as the interface, so that call is already a plain caller of `store.Store.ListGroups` and no implementation call exists — that test should still pass unchanged. Read it and confirm rather than assuming. If it fails, the fixture gained an implementation call and the test's claim ("the extra reporting is for the implementation's answer only") is what this task deliberately changes: update the comment and the assertion to name the new heading, and do not weaken `not.toContain('reach this method through')`, which guards a different claim.

- [ ] **Step 9: Run every test that reads a gap report or an answer's wording**

Run: `npx vitest run plugins/p-graph/tools/__tests__/cli-interface-reach.test.ts plugins/p-graph/tools/__tests__/interface-reach.test.ts plugins/p-graph/tools/__tests__/complete-answer.test.ts plugins/p-graph/tools/__tests__/all-guessed-answer.test.ts plugins/p-graph/tools/__tests__/call-sites.test.ts plugins/p-graph/tools/__tests__/cli-unresolved.test.ts plugins/p-graph/tools/__tests__/confidence.test.ts plugins/p-graph/tools/__tests__/context-guess-split.test.ts`

Expected: PASS.

- [ ] **Step 10: Run the whole suite on Windows, then under WSL**

Run on the host: `npx vitest run`

Then the run that counts:

```bash
tar --exclude=./node_modules --exclude=./.git --exclude=./.pgraph -cf - . | wsl -e bash -lc 'cd ~/pshed && tar -xf -'
wsl -e bash -lc 'export PATH=$HOME/.local/node24/bin:$PATH && cd ~/pshed && npx vitest run'
```

Expected: both green, same counts. Report both numbers and say which is the WSL run.

- [ ] **Step 11: Commit**

```bash
git add plugins/p-graph/tools/lib/destinations/local-sqlite.mjs plugins/p-graph/tools/lib/cli/commands.mjs plugins/p-graph/tools/__tests__/cli-implementation-reach.test.ts
git commit -m "feat(p-graph): callers on an interface method reports the calls that run an implementation"
```

---

### Task 4: Check it against the repository the gap was measured on, then ask about re-measuring

**Files:**
- Modify: `plugins/p-graph/README.md` (the "Name resolution" limits list — it names the wrong cause for this question today)
- No test file: this task's deliverable is a measurement and a decision, not code.

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: a real number for `callers caddyhttp.Handler.ServeHTTP` on the study's caddy clone, and a decision from the user about the re-measurement.

- [ ] **Step 1: Rebuild the study's caddy graph with the new code**

```bash
cd "$TEMP/pgraph-measure/caddy"
node "C:/projects/perky.team/claude-plugin/plugins/p-graph/tools/pgraph.mjs" index --full
```

Expected: it rebuilds rather than patches, because `SCHEMA_VERSION` moved to 12.

- [ ] **Step 2: Ask the question the study asks, and count**

```bash
node "C:/projects/perky.team/claude-plugin/plugins/p-graph/tools/pgraph.mjs" callers "caddyhttp.Handler.ServeHTTP" | grep -c "metrics_test.go"
```

Expected: **18**. Before this change it was 1. If it is not 18, stop and read which sites are missing before touching anything else — the truth list for that question is in `plugins/p-graph/scripts/measure-agent.mjs` under `id: 'caddy-handler-servehttp'` and names all 18 lines.

- [ ] **Step 3: Check that the interface method set is now complete**

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.TEMP+'/pgraph-measure/caddy/.pgraph/graph.db',{readOnly:true});
const q=(s,...a)=>db.prepare(s).all(...a);
let declared=0, recorded=0;
const fs=require('fs');
for (const i of q(\"SELECT id,file,start_line,end_line FROM nodes WHERE kind='interface' AND lang='go'\")) {
  const rec=q('SELECT name FROM nodes WHERE container_id = ?', i.id).length;
  let src=''; try { src=fs.readFileSync(process.env.TEMP+'/pgraph-measure/caddy/'+i.file,'utf8').split('\n').slice(i.start_line-1,i.end_line).join('\n'); } catch { continue; }
  const dec=[...src.matchAll(/^\s*([A-Za-z]\w*)\s*\(/gm)].length;
  if (dec>1) { declared+=dec; recorded+=rec; }
}
console.log('multi-method interfaces: declared', declared, 'recorded', recorded);
"
```

Expected: `declared 31 recorded 31`. Before this change it was `declared 31 recorded 13`.

- [ ] **Step 4: Correct the two places that name the wrong cause**

Both were checked against the code and the graph, and both are wrong today. `docs/measured-benefit.md` also mentions this question in its "what we got wrong" list — leave that alone, it is history and it was true when written.

**4a.** In `plugins/p-graph/README.md`, limit 1 of the "Name resolution" list (line 242) says the graph "does not read across files" for a receiver typed from a return value. It does, for a plain function — Pass R follows `#ret:<callee>` to the result type written in that callee's signature. Replace the whole numbered item with:

```markdown
**1. A receiver typed from a call whose result the graph has no row for.** Two shapes, and only one is still open. `x := newThing()` — a plain function in this repo — IS read: extraction records `x` as `#ret:newThing`, and the resolver follows that to the result type written in `newThing`'s own signature, across files. What stays open is a callee the graph cannot read a result for: one outside the repo (`x := reflect.ValueOf(v)`), or a method on a value that is not typed yet (`buf := bp.GetBuffer()`, where `bp` has to be resolved first — Go stops after one hop, and only Python takes the extra one). Those fall back to the unique bare name and become guesses. This is the largest remaining source of wrong rows: `collections.Namespace.Index` in hugo still prints 26 caller rows where `gopls` says 3, and all 25 false ones have this shape.
```

**4b.** In `plugins/p-graph/docs/superpowers/plans/2026-08-14-p-graph-lsp-arm.md`, lines 30-31 name "a receiver typed by a method call (7 of 34 sites on `caddyhttp.Handler.ServeHTTP`)" as the limit that question hit. Measured on the current graph, the receiver is read correctly in all 18 of those calls. Replace that clause with:

```markdown
The p-graph page already names the limits on its own side: a receiver typed by a method call on a
value that is not typed yet, a method promoted through embedding (dropped,
```

and add, after that paragraph:

```markdown
One entry in that list was later found to be misattributed. `caddyhttp.Handler.ServeHTTP` was not a
receiver-typing miss: the graph reads `ih := newMetricsInstrumentedRoute(…)` correctly and resolves
all 18 calls in `metrics_test.go` certainly, to `metricsInstrumentedRoute.ServeHTTP`. What was missing
was the question's shape — asked about the interface method, the graph had no way to report the calls
that run an implementation. See `2026-08-24-go-interface-method-set.md`.
```

- [ ] **Step 5: Commit the corrections**

```bash
git add plugins/p-graph/README.md plugins/p-graph/docs/superpowers/plans/2026-08-14-p-graph-lsp-arm.md
git commit -m "docs(p-graph): the Handler.ServeHTTP gap was the question's shape, not the receiver type"
```

- [ ] **Step 6: Ask the user about the re-measurement — do not start it**

This change alters what the p-graph arm answers, so `docs/measured-benefit.md` and both READMEs hold numbers that are now stale for that arm. State the following and wait:

- Only the graph arm changes. grep and the language-server arm are untouched, and their rows must not move.
- Re-running the graph arm is **156 runs**, about **$36** at the measured $0.23 a run, plus extraction, and several hours of wall clock.
- The expected direction, from Task 2's count: Go's list-question recall goes from 229/279 (82.1%) to about 277/279 (99.3%), and "all list questions" from 1494/1575 (94.9%) to about 1542/1575 (97.9%).
- The measured figures to compare against are in `plugins/p-graph/docs/measured-benefit.md`.

Ask which they want:

1. Re-run the graph arm now (`--phase graph` after deleting its rows from `runs.jsonl`), then `--score`, then update the write-up.
2. Re-run only the Go questions first, as a cheaper check that the direction is right, and decide after.
3. Leave the published numbers as they are for now, with a note in the write-up that the graph arm's code has moved ahead of its measurement.

---

## What this plan deliberately does not do

- **No embedded-method promotion.** Go promotes a method from an embedded field, and the graph drops embedding today (the README records 51 lost edges). A type that satisfies an interface only through an embedded field will still be missed. That is an under-report, which is the safe direction, and it is a separate piece of work.
- **No type comparison in `sigShape`.** Parameter count and "is there a result" only. The same type is spelled differently across a package boundary, so comparing type text would refuse honest matches. Two same-named methods with the same parameter count and the same result-ness but different types can still match — an over-report bounded to that shape, reported under a labelled heading rather than mixed into the certain rows.
- **No change to the TypeScript path.** `axios-eject` loses 8 of 25 sites to a different mechanism — `axios.interceptors.request.eject(...)`, a two-level property chain — and needs its own plan.
- **No new measurement.** Task 4 ends with a question, per this repo's rule about re-running the study after a resolution change.
