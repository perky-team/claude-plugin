# p-graph Trustworthy Answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every p-graph answer either correct or openly incomplete — no false edges, no silent holes, and a gap report short enough that people read it.

**Architecture:** Three new `edges` columns (`dst_bare`, `lang`, `external`) written at extraction time turn today's string guesswork into indexed facts. The resolver then gains guards that refuse a link it cannot justify (a Go builtin, a cross-language target, a non-callable symbol, a receiver whose type is known to live outside the repo), and re-resolves every call edge from scratch so an incremental index can never disagree with a full rebuild. The gap report stops keying on the name the user typed and keys on each call site's own bare name instead, then splits its rows into "may be a real missed call", "same name but the file cannot even see the target's package", and "leaves the repo".

**Tech Stack:** Node >= 22.5 (`node:sqlite`), vendored web-tree-sitter WASM grammars, vitest, plain ESM `.mjs` — no new dependencies.

## Global Constraints

- **No new dependencies.** Everything ships vendored; `package.json` must not change.
- **Node >= 22.5** is the floor (`node:sqlite`). Do not use APIs newer than Node 22.
- **All artifacts in English** — code, comments, tests, README, skills. Simple English: short sentences, everyday words.
- **Comments explain why, not what.** Match the existing density in `driver.mjs` and `local-sqlite.mjs`.
- **No new CLI flags, no new config options.** Everything must work by default. `--json` is the escape hatch for full data.
- **TDD is mandatory.** Write the failing test, run it, watch it fail for the right reason, then implement.
- **Never edit `plugins/p-graph/.claude-plugin/plugin.json`.** Version bumps happen only at release time, by the release procedure in `.claude/CLAUDE.md`.
- **`SCHEMA_VERSION` ends this plan at 6.** Bump it once, in Task 1, and not again.
- **Every task ends with a commit.** Conventional-commit prefixes (`feat(p-graph):`, `fix(p-graph):`, `docs(p-graph):`, `test(p-graph):`). Never add Claude attribution to a commit message.
- **Run the whole plugin suite before each commit:** `npx vitest run plugins/p-graph`. It must be green — 109 tests pass today.
- Windows + PowerShell is the working shell. The Bash tool is available for POSIX scripts; never mix the two syntaxes in one command.

---

## Background: what is broken

An independent evaluation indexed hugo (903 Go files), nestjs/nest (1727 TS files) and pallets/flask, built a 269-row ground-truth corpus, and measured. The findings this plan fixes:

| Defect | Evidence |
|---|---|
| False edges from Go builtins | 101 in hugo, e.g. `copy(env, e.baseEnviron)` linked to `template.Template.copy` |
| False edges across languages | 163 in hugo, e.g. a JS `result.push()` linked to a Go `template.state.push` |
| Call edges to non-callable symbols | 235 conversions/composite literals resolved to `type`/`struct` nodes |
| Bare-name fallback overrides a known-external receiver | `highlight.byteCountFlexiWriter.WriteRune` reports 13 callers, **all 13 false**, banner silent. Field type was correctly typed as `bytes.Buffer`, then the fallback linked the name anyway |
| An aliased import is never resolved, and the gap report cannot see it either | `callers bufferpool.GetBuffer` → 3 of 24 real call sites, **no banner**: 21 go through the import alias `bp`, recorded as `bp.GetBuffer`, which matches no package in the graph. Task 3 resolves them; Task 5 makes anything still missing visible |
| Own-receiver qualification hid gaps it used to show | 294 edges in hugo recorded as `Type.M` where no such node exists; the banner cannot match them |
| Resolved edges with no enclosing symbol are dropped in silence | 1348 in hugo, **5112 in nest (56.3% of all resolved edges)** |
| Incremental index disagrees with `--full` on the same tree | a newly ambiguous name stays resolved; `unattributed calls 0/1` vs `1/1` |
| Banner is 94–98% noise | `callers loggers.logAdapter.Errorf` → 0 callers and 387 gap lines, 365 of them `t.Errorf` from `testing` |

Out of scope for this plan, worth a follow-up plan of its own: C++ out-of-line method definitions (`std::string PgStore::Get(...)` uses a `qualified_identifier` declarator that `cpp.scm` never matches, so 2 of 4 files in a normal header/impl layout produce zero symbols), and TS/JS call-callback bodies (`describe`/`it` callbacks are not definitions, which is the root cause of nest's 56.3% figure — Task 5 makes those call sites visible but does not give them a caller).

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `plugins/p-graph/tools/lib/parse/driver.mjs` | AST → nodes/edges/fieldTypes. Owns every per-call-site fact: bare name, language, import-alias translation, whether the target can be a repo symbol, what a struct embeds | Modify (Tasks 1, 3) |
| `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs` | DDL, schema migration, edge resolution passes, read helpers including the gap report | Modify (Tasks 1, 2, 5) |
| `plugins/p-graph/tools/lib/index/build.mjs` | Full and incremental index orchestration; when resolution runs | Modify (Task 4) |
| `plugins/p-graph/tools/lib/cli/commands.mjs` | Command dispatch and human-readable output, including how the gap banner reads | Modify (Tasks 5, 6) |
| `plugins/p-graph/tools/__tests__/edge-facts.test.ts` | Task 1: the three new columns and the embed rows carry the right values | Create |
| `plugins/p-graph/tools/__tests__/false-edges.test.ts` | Task 2: each false-edge class from the evaluation, reproduced and refused | Create |
| `plugins/p-graph/tools/__tests__/alias-resolution.test.ts` | Task 3: an aliased import resolves; a shadowing local still does not | Create |
| `plugins/p-graph/tools/__tests__/resolve-idempotent.test.ts` | Task 4: incremental and full rebuild agree | Create |
| `plugins/p-graph/tools/__tests__/store-unresolved.test.ts` | Task 5: renamed API, name-independent matching, reasons | Modify |
| `plugins/p-graph/tools/__tests__/cli-unresolved.test.ts` | Task 6: banner grouping and counts | Modify |
| `plugins/p-graph/README.md`, `skills/query/SKILL.md`, `skills/help/SKILL.md`, `skills/_shared/templates/p-graph-rule.template.md` | Task 7: honest claims, measured numbers | Modify |
| `plugins/p-graph/docs/superpowers/plans/2026-07-31-p-graph-trustworthy-answers-results.md` | Task 8: before/after measurements on hugo, nest, flask | Create |

---

### Task 1: Per-call-site facts in the edge row

Today the resolver guesses from strings at query time: it cannot tell a Go builtin from a method, or a JS call from a Go one. Record those facts once, at extraction.

**Files:**
- Modify: `plugins/p-graph/tools/lib/parse/driver.mjs`
- Modify: `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs`
- Create: `plugins/p-graph/tools/__tests__/edge-facts.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: every edge object from `extract()` now carries `dst_bare` (string | null), `lang` (string), `external` (0 | 1). The `edges` table gains those three columns plus an index on `dst_bare`. `fieldTypes` gains rows keyed `"<struct qname>#embed"` whose `type` is the embedded type's package-qualified name. `openStore` drops and recreates the graph tables when the stored `schema_version` is lower than the code's. `SCHEMA_VERSION` is 6.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-graph/tools/__tests__/edge-facts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveLang } from '../lib/parse/index.mjs';
import { extract } from '../lib/parse/driver.mjs';

const GO = `package api
import (
	"bytes"
	"fmt"
)
type W struct {
	sync.Mutex
	Base
	buf bytes.Buffer
}
func (w *W) Do() {
	n := copy(w.b, w.a)
	_ = float64(n)
	fmt.Println(n)
	w.helper()
}
func (w *W) helper() {}
`;

const run = (file, source) => {
  const cfg = resolveLang(file);
  return extract({ file, lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source });
};

describe('edge facts recorded at extraction', () => {
  it('records the bare name of every call target', async () => {
    const { edges } = await run('api.go', GO);
    const byBare = Object.fromEntries(
      edges.filter((e) => e.kind === 'call').map((e) => [e.dst_name, e.dst_bare]));
    expect(byBare['fmt.Println']).toBe('Println');   // package selector
    expect(byBare['api.W.helper']).toBe('helper');   // own receiver
    expect(byBare['copy']).toBe('copy');             // already bare
  }, 20000);

  it('marks a Go builtin call and a predeclared-type conversion as external', async () => {
    const { edges } = await run('api.go', GO);
    const call = (name) => edges.find((e) => e.kind === 'call' && e.dst_name === name);
    expect(call('copy').external).toBe(1);
    expect(call('api.float64').external).toBe(1);
    // A call into an imported package is not marked here: at extraction we cannot
    // tell a third-party package from one that lives in this repo. That is decided
    // at query time, by whether any repo symbol shares the bare name.
    expect(call('fmt.Println').external).toBe(0);
    expect(call('api.W.helper').external).toBe(0);
  }, 20000);

  it('stamps every edge with the language of its file', async () => {
    const { edges } = await run('api.go', GO);
    expect(edges.every((e) => e.lang === 'go')).toBe(true);
    const ts = await run('a.ts', 'class C { run() { this.go(); } go() {} }');
    expect(ts.edges.every((e) => e.lang === 'ts')).toBe(true);
  }, 20000);

  it('records what a Go struct embeds, separately from its named fields', async () => {
    const { fieldTypes } = await run('api.go', GO);
    const embeds = fieldTypes.filter((f) => f.key === 'api.W#embed').map((f) => f.type).sort();
    expect(embeds).toEqual(['api.Base', 'sync.Mutex']);
    // named fields keep their own keys
    expect(fieldTypes.find((f) => f.key === 'api.W.buf')?.type).toBe('bytes.Buffer');
  }, 20000);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/edge-facts.test.ts
```

Expected: 4 failures. The first three report `expected undefined to be …` because `dst_bare` / `external` / `lang` do not exist on the edge objects. The fourth reports `expected [] to equal [ 'api.Base', 'sync.Mutex' ]` because embedded fields are skipped today.

- [ ] **Step 3: Add the facts in the driver**

In `plugins/p-graph/tools/lib/parse/driver.mjs`, after the `GO_BUILTINS` set, add:

```js
// Go's predeclared type names. `float64(n)` parses as a call, but it converts a
// value — it never targets a repo symbol, so it must not be resolved or reported
// as a gap.
const GO_PREDECLARED_TYPES = new Set([
  'any', 'bool', 'byte', 'comparable', 'complex64', 'complex128', 'error',
  'float32', 'float64', 'int', 'int8', 'int16', 'int32', 'int64', 'rune',
  'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
]);

// The last segment of a dotted target name. A call site records whatever the
// source wrote — `bp.GetBuffer` under an import alias, `api.W.helper` for an own
// receiver — so the bare segment is the only part that is stable across
// qualifiers, and it is what the gap report has to match on.
const bareSegment = (name) =>
  typeof name === 'string' && name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
```

In the `fieldTypes` block inside `extract`, replace the named-field loop:

```js
      let hasNamedField = false;
      for (let i = 0; i < node.childCount; i++) {
        if (node.fieldNameForChild(i) !== 'name') continue;
        hasNamedField = true;
        fieldTypes.push({ key: `${structDef.qname}.${node.child(i).text}`, type: typeName, file });
      }
      // An embedded field has a type and no name. Record it under a synthetic
      // "#embed" key: knowing what a struct embeds is what lets the resolver tell
      // a real promoted method (the struct embeds a repo type) from a call on an
      // external one (`struct{ sync.Mutex }` and then `l.Lock()`).
      if (!hasNamedField) fieldTypes.push({ key: `${structDef.qname}#embed`, type: typeName, file });
```

In the edges loop, replace the `edges.push({...})` call:

```js
    // A plain-identifier call to a builtin or a predeclared type names nothing in
    // the repo. Marked here, once, so neither the resolver nor the gap report has
    // to keep a Go word list in SQL.
    const external = lang === 'go' && c.node?.type !== 'field_identifier' &&
      (GO_BUILTINS.has(c.text) || GO_PREDECLARED_TYPES.has(c.text)) ? 1 : 0;
    edges.push({
      src_id: enclosing ? enclosing.id : null,
      dst_id: null, dst_name, dst_bare: bareSegment(dst_name), lang, external,
      field_key, method, kind, file, line: c.startLine,
    });
```

- [ ] **Step 4: Add the columns and a real migration in the store**

In `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs`, bump the version and document it:

```js
// 6: edges gained dst_bare/lang/external, and field_types gained "#embed" rows.
// These are new columns, which CREATE TABLE IF NOT EXISTS can never add to an
// existing table, so openStore now drops the graph tables when the stored version
// is older. The DB is a rebuildable cache; dropping it costs one reindex.
export const SCHEMA_VERSION = 6;
```

Split the DDL so the version can be read before the graph tables are touched:

```js
const META_DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

const DDL = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, hash TEXT, lang TEXT, indexed_at TEXT
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, name TEXT, qname TEXT, kind TEXT, lang TEXT,
  file TEXT, start_line INTEGER, end_line INTEGER,
  signature TEXT, doc TEXT, container_id TEXT
);
CREATE INDEX IF NOT EXISTS nodes_file ON nodes(file);
CREATE INDEX IF NOT EXISTS nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS nodes_qname ON nodes(qname);
CREATE TABLE IF NOT EXISTS edges (
  src_id TEXT, dst_id TEXT, dst_name TEXT, kind TEXT, file TEXT, line INTEGER,
  field_key TEXT, method TEXT, dst_bare TEXT, lang TEXT, external INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src_id);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst_id);
CREATE INDEX IF NOT EXISTS edges_dstname ON edges(dst_name);
CREATE INDEX IF NOT EXISTS edges_dstbare ON edges(dst_bare);
CREATE INDEX IF NOT EXISTS edges_file ON edges(file);
CREATE INDEX IF NOT EXISTS edges_fieldkey ON edges(field_key);
-- Struct-field-type table for Go: key "<pkg>.<Struct>.<field>" -> package-
-- qualified field type ('*' stripped), e.g. "events.Server.dimpleCore" ->
-- "core.Core". The key "<pkg>.<Struct>#embed" holds an embedded type instead.
CREATE TABLE IF NOT EXISTS field_types (
  key TEXT, type TEXT, file TEXT
);
CREATE INDEX IF NOT EXISTS field_types_key ON field_types(key);
CREATE INDEX IF NOT EXISTS field_types_file ON field_types(file);
`;
```

In `openStore`, replace `db.exec(DDL);` with:

```js
  db.exec(META_DDL);
  // A schema bump can add columns, and CREATE TABLE IF NOT EXISTS will not add
  // them to a table that already exists — a prepared statement would then fail on
  // a missing column and take the whole CLI down. The graph is a rebuildable
  // cache, so drop it and let the next index refill it.
  const storedVersion = Number(db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()?.value);
  if (storedVersion && storedVersion < SCHEMA_VERSION) {
    for (const t of ['nodes_fts', 'edges', 'nodes', 'files', 'field_types']) {
      db.exec(`DROP TABLE IF EXISTS ${t}`);
    }
  }
  db.exec(DDL);
```

**Leave the stored `schema_version` row alone.** Do not clear it here. `openStore` re-stamps a missing version to the current one a few lines further down, which would make the empty, just-dropped graph look current — `ensureFresh()` would then skip the rebuild, and the existing "rebuilds after a schema upgrade" test in `cli-autorefresh.test.ts` fails. Only `markSchemaCurrent()`, called at the end of a real `indexFull`, may raise the version.

Widen the insert statement:

```js
  const insEdge = db.prepare(
    `INSERT INTO edges (src_id,dst_id,dst_name,kind,file,line,field_key,method,dst_bare,lang,external)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
```

And in `store.replaceFileSymbols`, widen the loop:

```js
      for (const e of edges) insEdge.run(e.src_id, e.dst_id ?? null, e.dst_name ?? null,
        e.kind, e.file, e.line, e.field_key ?? null, e.method ?? null,
        e.dst_bare ?? null, e.lang ?? null, e.external ?? 0);
```

- [ ] **Step 5: Run the new test and the whole suite**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/edge-facts.test.ts
npx vitest run plugins/p-graph
```

Expected: the 4 new tests pass; the suite is green at 113 tests. If `store-write.test.ts` or `store-read.test.ts` fail, they hand-build edge rows without the new fields — the `?? null` / `?? 0` defaults above are what keeps them working, so read the failure before changing any test.

- [ ] **Step 6: Prove the migration on a real old database**

```powershell
$d = "$env:TEMP\pg-mig"; Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$d\.git", "$d\.pgraph" | Out-Null
Set-Content "$d\a.ts" "function foo() { bar(); }`nfunction bar() {}" -Encoding utf8
node plugins/p-graph/tools/pgraph.mjs index --full
```

Run that from `$d`, then force the DB to look old and query it:

```powershell
node --input-type=module -e "import {openStore} from 'file:///C:/projects/perky.team/claude-plugin/plugins/p-graph/tools/lib/destinations/local-sqlite.mjs'; const s = openStore(process.argv[1]); s.setMeta('schema_version', '3'); s.close();" "$d\.pgraph\graph.db"
node plugins/p-graph/tools/pgraph.mjs status
```

Expected: `status` prints a line with `schema 6` and does not throw. Before this task the same sequence threw `table edges has no column named dst_bare`.

- [ ] **Step 7: Commit**

```powershell
git add plugins/p-graph/tools/lib/parse/driver.mjs plugins/p-graph/tools/lib/destinations/local-sqlite.mjs plugins/p-graph/tools/__tests__/edge-facts.test.ts
git commit -m "feat(p-graph): record per-call-site facts (bare name, language, external) and migrate the schema by rebuild"
```

---

### Task 2: Refuse every link the graph cannot justify

The README claims p-graph "never invents a false edge". It does — measurably. Five classes, five guards.

**Files:**
- Modify: `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs` (`store.resolvePending`)
- Create: `plugins/p-graph/tools/__tests__/false-edges.test.ts`

**Interfaces:**
- Consumes: `edges.dst_bare`, `edges.lang`, `edges.external`, and `field_types` rows keyed `"<struct qname>#embed"` from Task 1.
- Produces: `store.resolvePending()` resolves only `kind = 'call'` edges, only to nodes of kind `function`/`method`/`class`, only within the same language, never when `external = 1`.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-graph/tools/__tests__/false-edges.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-false-')); });
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

// Each case below is a false edge the evaluation found in hugo, shrunk to the
// smallest source that reproduces it.
describe('the resolver refuses links it cannot justify', () => {
  it('never links a Go builtin call to a same-named method', async () => {
    write('exec/exec.go', `package exec
type E struct{ a []int; b []int }
func (e *E) Run() { copy(e.b, e.a) }
`);
    write('tpl/tpl.go', `package tpl
type Template struct{}
func (t *Template) copy() {}
`);
    const store = await indexed();
    expect(store.callers('tpl.Template.copy')).toEqual([]);
    store.close();
  }, 30000);

  it('never links a call across languages', async () => {
    write('live/live.js', 'function boot(result, key) { result.push(key); }');
    write('tpl/tpl.go', `package tpl
type state struct{}
func (s *state) push() {}
`);
    const store = await indexed();
    expect(store.callers('tpl.state.push')).toEqual([]);
    store.close();
  }, 30000);

  it('never links a call to a type or a struct', async () => {
    write('cfg/cfg.go', `package cfg
type Duration int64
func Parse(v int64) Duration { return Duration(v) }
`);
    const store = await indexed();
    expect(store.callers('cfg.Duration')).toEqual([]);
    store.close();
  }, 30000);

  it('never falls back to a bare name when the receiver field has a known external type', async () => {
    write('goldmark/autoid.go', `package goldmark
import "bytes"
type W struct{ buf bytes.Buffer }
func (w *W) Do() { w.buf.WriteRune('-') }
`);
    write('highlight/highlight.go', `package highlight
type counter struct{}
func (c *counter) WriteRune(r rune) {}
`);
    const store = await indexed();
    // bytes.Buffer is not a repo type, so this call leaves the repo. Linking it
    // to the one repo method that happens to be called WriteRune is a lie.
    expect(store.callers('highlight.counter.WriteRune')).toEqual([]);
    store.close();
  }, 30000);

  it('never treats a func-typed field as a promoted method', async () => {
    write('filecache/filecache.go', `package filecache
type L struct{ unlock func() }
func (l *L) Do() { l.unlock() }
`);
    write('doctree/doctree.go', `package doctree
type T struct{}
func (t *T) unlock() {}
`);
    const store = await indexed();
    expect(store.callers('doctree.T.unlock')).toEqual([]);
    store.close();
  }, 30000);

  it('never treats a method of an embedded external type as a repo method', async () => {
    write('svc/svc.go', `package svc
import "sync"
type S struct{ sync.Mutex }
func (s *S) Do() { s.Lock() }
`);
    write('other/other.go', `package other
type Gate struct{}
func (g *Gate) Lock() {}
`);
    const store = await indexed();
    expect(store.callers('other.Gate.Lock')).toEqual([]);
    store.close();
  }, 30000);

  it('still links a method promoted from an embedded repo type', async () => {
    write('base/base.go', `package base
type Base struct{}
func (b *Base) Shared() {}
`);
    write('wrap/wrap.go', `package wrap
import "x/base"
type Wrap struct{ base.Base }
func (w *Wrap) Do() { w.Shared() }
`);
    const store = await indexed();
    expect(store.callers('base.Base.Shared').map((n) => n.qname)).toEqual(['wrap.Wrap.Do']);
    store.close();
  }, 30000);

  it('never resolves an import edge to a symbol', async () => {
    write('a/a.go', `package a
import "x/b"
func Use() { b.Do() }
`);
    write('b/b.go', `package b
func Do() {}
`);
    const store = await indexed();
    const resolvedImports = store.db.prepare(
      `SELECT count(*) c FROM edges WHERE kind = 'import' AND dst_id IS NOT NULL`).get().c;
    expect(resolvedImports).toBe(0);
    store.close();
  }, 30000);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/false-edges.test.ts
```

Expected: 6 of 8 fail, each reporting a caller where the answer must be empty — for example `expected [ { qname: 'tpl.Template.copy' … } ] to deeply equal []`. The "still links a promoted method" and "never resolves an import edge" cases already pass; they are the regression guards.

- [ ] **Step 3: Rewrite the resolution passes with the guards**

In `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs`, replace the whole body of `store.resolvePending` with:

```js
  store.resolvePending = () => {
    // Only these kinds can be the target of a call. A Go conversion
    // (`Duration(v)`) and a composite literal parse as calls but name a type, and
    // a call edge into a type node makes callers/impact report a caller that does
    // not exist. `class` stays in: `new Service()` in TS and a C++ constructor
    // call really do target one.
    const CALLABLE = `('function','method','class')`;
    // Invalidate every call edge and resolve from scratch. A resolved edge can
    // become ambiguous when a new same-named symbol appears, so keeping it would
    // make an incremental index answer differently from a full rebuild —
    // silently, and in the direction of false confidence.
    db.prepare(`UPDATE edges SET dst_id = NULL WHERE kind = 'call'`).run();

    // Pass A — exact qualified match. "filesink.New" links to the node whose
    // qname is "filesink.New", in the same language, and only when it is unique.
    db.prepare(`
      UPDATE edges SET dst_id = (
        SELECT n.id FROM nodes n
        WHERE n.qname = edges.dst_name AND n.lang = edges.lang AND n.kind IN ${CALLABLE}
        LIMIT 1
      )
      WHERE kind = 'call' AND dst_id IS NULL AND dst_name IS NOT NULL AND external = 0
        AND (SELECT count(*) FROM nodes n
             WHERE n.qname = edges.dst_name AND n.lang = edges.lang AND n.kind IN ${CALLABLE}) = 1`).run();

    // Pass F — Go recv.field.Method() through the field-type table. Runs before
    // the bare-name fallback so an ambiguous method name links to the RIGHT type.
    // Guarded twice: exactly one known field type for the key, and exactly one
    // node with the target qname.
    db.prepare(`
      UPDATE edges SET dst_id = (
        SELECT n.id FROM nodes n
        WHERE n.qname = (SELECT ft.type FROM field_types ft WHERE ft.key = edges.field_key LIMIT 1) || '.' || edges.method
          AND n.lang = edges.lang AND n.kind IN ${CALLABLE}
        LIMIT 1
      )
      WHERE kind = 'call' AND dst_id IS NULL AND field_key IS NOT NULL AND method IS NOT NULL
        AND (SELECT count(DISTINCT ft.type) FROM field_types ft WHERE ft.key = edges.field_key) = 1
        AND (SELECT count(*) FROM nodes n
             WHERE n.qname = (SELECT ft.type FROM field_types ft WHERE ft.key = edges.field_key LIMIT 1) || '.' || edges.method
               AND n.lang = edges.lang AND n.kind IN ${CALLABLE}) = 1`).run();

    // Pass B — a unique bare-name match, only when no qualified candidate exists.
    // The extra guard is the one the evaluation showed missing: a call through a
    // field must not fall back to an unrelated same-named method just because
    // Pass F's exact `<type>.<method>` lookup failed. The only other legitimate
    // target is a method PROMOTED into the field's type from an embedded repo
    // type — the same rule Pass C applies to a call on the method's own
    // receiver. So when the field's type is known, require it to embed a repo
    // type (a `"<type>#embed"` row pointing at a node that exists); otherwise
    // refuse. This also covers a field typed as a repo-defined interface: the
    // interface node exists, so a plain "is it a repo type" check would let it
    // through, but an interface embeds nothing and has no method declarations of
    // its own, so it can never supply a legitimate target. Linking the bare name
    // to the one repo method that shares it produced 13 false callers for a
    // single symbol in hugo.
    db.prepare(`
      UPDATE edges SET dst_id = (
        SELECT n.id FROM nodes n
        WHERE n.name = edges.dst_name AND n.lang = edges.lang AND n.kind IN ${CALLABLE}
        LIMIT 1
      )
      WHERE kind = 'call' AND dst_id IS NULL AND dst_name IS NOT NULL AND external = 0
        AND (SELECT count(*) FROM nodes n WHERE n.qname = edges.dst_name AND n.lang = edges.lang) = 0
        AND (SELECT count(*) FROM nodes n
             WHERE n.name = edges.dst_name AND n.lang = edges.lang AND n.kind IN ${CALLABLE}) = 1
        AND NOT EXISTS (
          SELECT 1 FROM field_types ft
          WHERE ft.key = edges.field_key
            AND NOT EXISTS (
              SELECT 1 FROM field_types emb JOIN nodes en ON en.qname = emb.type
              WHERE emb.key = ft.type || '#embed'))`).run();

    resolveOwnReceiverFallback();
  };

  // Pass C — a receiver-qualified guess that missed. `s.M()` is stored as
  // "<own type>.M"; when no such node exists, M is inherited or promoted. Falling
  // back to a unique bare name is right for real promotion and wrong when the
  // type only embeds something external (`struct{ sync.Mutex }` then `s.Lock()`)
  // or embeds nothing at all (`unlock` is a func-typed field, not a method). Go
  // records what it embeds, so require an embedded repo type there. Other
  // languages do not index inheritance, so they keep the plain fallback — that is
  // what links Python's `self._find_error_handler` to the base class.
  const resolveOwnReceiverFallback = () => {
    const candidates = db.prepare(`
      SELECT rowid, dst_name, dst_bare, lang FROM edges
      WHERE kind = 'call' AND dst_id IS NULL AND external = 0
        AND method IS NOT NULL AND field_key IS NULL AND dst_bare IS NOT NULL`).all();
    if (!candidates.length) return;
    const embedsRepoType = db.prepare(`
      SELECT 1 FROM field_types ft JOIN nodes n ON n.qname = ft.type
      WHERE ft.key = ? LIMIT 1`);
    const byBareName = db.prepare(`
      SELECT n.id FROM nodes n
      WHERE n.name = ? AND n.lang = ? AND n.kind IN ('function','method','class') LIMIT 2`);
    const setDst = db.prepare('UPDATE edges SET dst_id = ? WHERE rowid = ?');
    for (const e of candidates) {
      const owner = e.dst_name.slice(0, Math.max(0, e.dst_name.length - e.dst_bare.length - 1));
      if (e.lang === 'go' && !(owner && embedsRepoType.get(`${owner}#embed`))) continue;
      const hits = byBareName.all(e.dst_bare, e.lang);
      if (hits.length === 1) setDst.run(hits[0].id, e.rowid);
    }
  };
```

Note the ordering: `store.resolvePending` references `resolveOwnReceiverFallback`, which is declared with `const` afterwards. That works because the call happens at query time, not at definition time — but declare it *before* `store.resolvePending` if you prefer reading top-down. Either way, keep it inside `openStore` so it closes over `db`.

- [ ] **Step 4: Run the test and the whole suite**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/false-edges.test.ts
npx vitest run plugins/p-graph
```

Expected: 8/8 in the new file. In the suite, `self-receiver-resolution.test.ts` must stay green — especially "keeps the bare-name fallback for a promoted method of an embedded struct", which now passes through the embed guard. If it fails, the `#embed` rows are missing or the owner name is being sliced wrongly; print `owner` and the `field_types` rows before touching the test.

- [ ] **Step 5: Commit**

```powershell
git add plugins/p-graph/tools/lib/destinations/local-sqlite.mjs plugins/p-graph/tools/__tests__/false-edges.test.ts
git commit -m "fix(p-graph): stop inventing call edges (builtins, cross-language, non-callable targets, external receivers)"
```

---

### Task 3: Resolve a call made through an import alias

`callers bufferpool.GetBuffer` found 3 of 24 real call sites in hugo. The other 21 write `bp.GetBuffer` under an import alias, and `bp` matches no package in the graph, so those calls are **never** resolved — not ambiguous, just lost. Every one of them would otherwise become a banner line that Task 6 has to print, so fixing this shortens the banner and lengthens the answer at the same time.

**Files:**
- Modify: `plugins/p-graph/tools/lib/parse/driver.mjs` (`goContext`, `goCallTarget`)
- Create: `plugins/p-graph/tools/__tests__/alias-resolution.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `goContext` returns `{ pkg, importPkgs, hasDotImport }` where `importPkgs` is a `Map` from the identifier a call site writes to the imported package's real name (the path's last segment). The `importNames` `Set` is gone — every reader must use `importPkgs`. A call `bp.GetBuffer()` now records `dst_name = "bufferpool.GetBuffer"`.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-graph/tools/__tests__/alias-resolution.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-alias-')); });
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

describe('Go import aliases', () => {
  it('resolves a call written through an import alias', async () => {
    write('internal/bufferpool/pool.go', `package bufferpool
func GetBuffer() []byte { return nil }
`);
    write('markup/goldmark.go', `package goldmark
import bp "x/internal/bufferpool"
func Render() []byte { return bp.GetBuffer() }
`);
    const store = await indexed();

    expect(store.callers('bufferpool.GetBuffer').map((n) => n.qname)).toEqual(['goldmark.Render']);
    expect(store.status().unresolved_calls).toBe(0);
    store.close();
  }, 30000);

  it('still resolves a plain, unaliased import', async () => {
    write('internal/bufferpool/pool.go', `package bufferpool
func GetBuffer() []byte { return nil }
`);
    write('markup/plain.go', `package markup
import "x/internal/bufferpool"
func Render() []byte { return bufferpool.GetBuffer() }
`);
    const store = await indexed();

    expect(store.callers('bufferpool.GetBuffer').map((n) => n.qname)).toEqual(['markup.Render']);
    store.close();
  }, 30000);

  it('leaves a call on a local variable that shadows an imported package unresolved', async () => {
    write('config/config.go', `package config
func Load() {}
`);
    write('related/related.go', `package related
import "x/config"
type IndexConfig struct{}
func (c IndexConfig) ToKeywords() {}
func Do() {
	config := IndexConfig{}
	config.ToKeywords()
}
`);
    const store = await indexed();

    // `config` is a local variable here, but the graph cannot know that — it sees
    // an identifier that names an imported package. Recording the call as
    // config.ToKeywords is wrong-but-honest: no edge is created, and Task 5's gap
    // report finds it by the bare name instead.
    expect(store.callers('related.IndexConfig.ToKeywords')).toEqual([]);
    const edge = store.db.prepare(
      `SELECT dst_name, dst_bare FROM edges WHERE kind = 'call' AND line = 7`).get();
    expect(edge.dst_name).toBe('config.ToKeywords');
    expect(edge.dst_bare).toBe('ToKeywords');
    store.close();
  }, 30000);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/alias-resolution.test.ts
```

Expected: the first test fails with `expected [] to deeply equal [ 'goldmark.Render' ]` — the alias call is unresolved today. Tests 2 and 3 already pass; they are the regression guards.

- [ ] **Step 3: Translate the alias in the driver**

In `plugins/p-graph/tools/lib/parse/driver.mjs`, replace `goContext` (and the comment block above it) with:

```js
// Per-file Go context used to qualify symbol names. `pkg` is the declared
// package. `importPkgs` maps the identifier a call site writes to the imported
// package's real name — they differ under an alias (`bp "x/util/bufferpool"`
// writes `bp` but every symbol's qname says `bufferpool`), so the alias has to be
// translated or the call can never match a qname. `hasDotImport` flags a
// `import . "x"`, which makes a bare identifier possibly belong to another
// package, so same-package qualification must be skipped for the whole file.
function goContext(caps) {
  let pkg = null;
  for (const c of caps) if (c.name === 'package') { pkg = c.text; break; }
  const importPkgs = new Map();
  let hasDotImport = false;
  for (const c of caps) {
    if (c.name !== 'reference.import') continue;
    const path = c.text.replace(/^["'`]|["'`]$/g, '');
    const seg = path.split('/').pop();
    const nameChild = c.node?.parent?.childForFieldName?.('name');
    if (nameChild) {
      if (nameChild.type === 'dot') { hasDotImport = true; continue; }
      if (nameChild.type === 'blank_identifier') continue;
      if (nameChild.type === 'package_identifier') {
        importPkgs.set(nameChild.text, seg || nameChild.text);
        continue;
      }
    }
    if (seg) importPkgs.set(seg, seg);
  }
  return { pkg, importPkgs, hasDotImport };
}
```

Then in `goCallTarget`, change the signature and the identifier-operand branch:

```js
function goCallTarget(c, { pkg, importPkgs, hasDotImport }) {
  const node = c.node;
  if (node?.type === 'field_identifier') {
    const operand = node.parent?.childForFieldName?.('operand');
    if (operand?.type === 'identifier') {
      // An imported package, under whatever name this file calls it.
      const importedAs = importPkgs.get(operand.text);
      if (importedAs) return `${importedAs}.${c.text}`;
      if (operand.text === pkg) return `${pkg}.${c.text}`;
      return { bare: c.text, recvVar: operand.text, method: c.text };
    }
    if (operand?.type === 'selector_expression') {
      const innerRecv = operand.childForFieldName?.('operand');
      const innerField = operand.childForFieldName?.('field');
      if (innerRecv?.type === 'identifier' && innerField?.type === 'field_identifier') {
        return { bare: c.text, recvVar: innerRecv.text, field: innerField.text, method: c.text };
      }
    }
    return c.text; // receiver is an expression, not a name — keep bare name
  }
  if (pkg && !hasDotImport && !GO_BUILTINS.has(c.text)) return `${pkg}.${c.text}`;
  return c.text;
}
```

- [ ] **Step 4: Run the test and the whole suite**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/alias-resolution.test.ts
npx vitest run plugins/p-graph
```

Expected: 3/3 in the new file, suite green. `lang-go.test.ts` and `go-resolution.test.ts` exercise unaliased imports and `fmt.Println`; if either fails, `importPkgs` is not being filled for a plain import — the `if (seg) importPkgs.set(seg, seg)` line is what covers that case.

- [ ] **Step 5: Commit**

```powershell
git add plugins/p-graph/tools/lib/parse/driver.mjs plugins/p-graph/tools/__tests__/alias-resolution.test.ts
git commit -m "feat(p-graph): resolve Go calls written through an import alias"
```

---

### Task 4: An incremental index must answer like a full rebuild

Task 2 already re-resolves from scratch. This task proves it and measures what it costs, because every query auto-refreshes and a slow resolve would be felt on every question.

**Files:**
- Create: `plugins/p-graph/tools/__tests__/resolve-idempotent.test.ts`
- Modify: `plugins/p-graph/tools/lib/index/build.mjs:131` (the "skip resolvePending" shortcut)

**Interfaces:**
- Consumes: `store.resolvePending()` from Task 2.
- Produces: no API change. `indexChanged` calls `resolvePending()` whenever anything was reparsed or deleted, and the resolution state after an incremental index equals the state after a full rebuild.

- [ ] **Step 1: Write the failing test**

Create `plugins/p-graph/tools/__tests__/resolve-idempotent.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull, indexChanged } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-idem-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};
const resolution = (store) => store.db.prepare(`
  SELECT file, line, dst_name, COALESCE(dst_id, 'NULL') AS dst
  FROM edges WHERE kind = 'call' ORDER BY file, line, dst_name`).all();

describe('incremental resolution matches a full rebuild', () => {
  it('drops an edge that a newly added same-named symbol made ambiguous', async () => {
    write('pkga/a.go', `package pkga
type A struct{}
func (a *A) Frobnicate() {}
`);
    write('caller/c.go', `package caller
import "x/pkga"
func Do(a *pkga.A) { a.Frobnicate() }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });
    expect(store.callers('pkga.A.Frobnicate').map((n) => n.qname)).toEqual(['caller.Do']);

    // A second Frobnicate appears. `a` is a parameter, so the graph cannot tell
    // which one caller.Do calls any more — the edge must go, not linger.
    write('pkgb/b.go', `package pkgb
type B struct{}
func (b *B) Frobnicate() {}
`);
    await indexChanged({
      root: dir, store, ignorePatterns: [],
      changedFiles: () => ({ modified: ['pkgb/b.go'], deleted: [] }),
    });
    expect(store.callers('pkga.A.Frobnicate')).toEqual([]);
    expect(store.status().unresolved_calls).toBe(1);
    store.close();
  }, 30000);

  it('produces the same resolution as a full rebuild of the same tree', async () => {
    write('pkga/a.go', `package pkga
type A struct{}
func (a *A) Shared() {}
func (a *A) Own() { a.Shared() }
`);
    write('caller/c.go', `package caller
import "x/pkga"
func Do(a *pkga.A) { a.Shared() }
`);
    const inc = openStore(':memory:');
    await indexFull({ root: dir, store: inc, ignorePatterns: [] });
    write('pkgb/b.go', `package pkgb
type B struct{}
func (b *B) Shared() {}
`);
    await indexChanged({
      root: dir, store: inc, ignorePatterns: [],
      changedFiles: () => ({ modified: ['pkgb/b.go'], deleted: [] }),
    });

    const full = openStore(':memory:');
    await indexFull({ root: dir, store: full, ignorePatterns: [] });

    // Node ids are content-addressed, so the two graphs are comparable row by row.
    expect(resolution(inc)).toEqual(resolution(full));
    inc.close(); full.close();
  }, 30000);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/resolve-idempotent.test.ts
```

Expected: both fail if Task 2 is not in place. With Task 2 committed, the first may already pass; the second can still fail because `indexChanged` skips `resolvePending()` when nothing changed in the *calling* file. Read the actual failure before implementing.

- [ ] **Step 3: Always resolve when the graph changed**

In `plugins/p-graph/tools/lib/index/build.mjs`, replace the conditional at the end of `indexChanged`:

```js
  // Resolution now depends on the whole symbol table, not just the reparsed
  // files: one new same-named symbol can make an edge in an untouched file
  // ambiguous. Resolve whenever anything moved, so an incremental index can never
  // answer differently from a full rebuild.
  if (n > 0 || change.deleted.length > 0) store.resolvePending();
```

If the existing comment already says this and the condition is identical, leave the code alone and record in the commit message that no change was needed. Do not weaken the condition to "always" — a query over a clean tree must stay a no-op.

- [ ] **Step 4: Run the test and the whole suite**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/resolve-idempotent.test.ts
npx vitest run plugins/p-graph
```

Expected: both new tests pass, suite green.

- [ ] **Step 5: Measure the cost of resolving from scratch**

Clone a real repo outside the project tree and time it:

```bash
cd "$TMPDIR" && git clone --depth 1 https://github.com/gohugoio/hugo hugo-bench && cd hugo-bench && mkdir -p .pgraph
time node /c/projects/perky.team/claude-plugin/plugins/p-graph/tools/pgraph.mjs index --full
printf 'package main\nfunc benchProbe() {}\n' > benchprobe.go
time node /c/projects/perky.team/claude-plugin/plugins/p-graph/tools/pgraph.mjs index
time node /c/projects/perky.team/claude-plugin/plugins/p-graph/tools/pgraph.mjs callers hugolib.HugoSites.Build
```

Record the three timings in the commit message. The reference numbers before this plan were: full index 19.5 s, incremental after one edit 0.59 s, `callers` 0.32 s. **If the incremental index now exceeds 5 s, stop and report the number instead of committing** — a per-query cost that large needs a narrower invalidation (only edges whose `dst_bare` appears in the changed files) and that is a design decision, not a detail.

- [ ] **Step 6: Commit**

```powershell
git add plugins/p-graph/tools/lib/index/build.mjs plugins/p-graph/tools/__tests__/resolve-idempotent.test.ts
git commit -m "fix(p-graph): keep incremental resolution identical to a full rebuild"
```

---

### Task 5: A gap report that finds the gaps

The banner keys on the name the user typed. Every gap recorded under a different qualifier is invisible — 171 import aliases, 294 failed own-receiver guesses, and thousands of call sites with no enclosing symbol.

**Files:**
- Modify: `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs` (`attachReadHelpers`)
- Modify: `plugins/p-graph/tools/__tests__/store-unresolved.test.ts`

**Interfaces:**
- Consumes: `edges.dst_bare`, `edges.lang`, `edges.external` from Task 1.
- Produces: `store.gapsFor(name)`, `store.gapsFrom(name)`, `store.gapsAround(name)` — replacing `unresolvedFor` / `unresolvedFrom` / `unresolvedAround`. Every returned row is `{ file, line, dst_name, src_qname, reason, reachable }` where `reason` is `'ambiguous' | 'external' | 'no-caller'` and `reachable` is `1` unless the row is a Go `'ambiguous'` gap in a file that neither belongs to nor imports the target's package. Rows are sorted by `file`, then `line`, and deduplicated on `file|line|dst_name`.

- [ ] **Step 1: Write the failing test**

Replace the body of `plugins/p-graph/tools/__tests__/store-unresolved.test.ts` with this (keep the imports and the `write` helper at the top of the existing file):

```ts
// Fixture with the three shapes that hide from a name-keyed report: a local
// variable that shadows an imported package, a failed own-receiver guess, and a
// call site outside any indexed symbol.
function writeHidingFixture() {
  write('internal/config/config.go', `package config
func Load() {}
`);
  write('internal/related/related.go', `package related
import "x/internal/config"
type IndexConfig struct{}
func (c IndexConfig) ToKeywords() {}
func Do() {
	config := IndexConfig{}
	config.ToKeywords()
}
`);
  write('internal/emb/emb.go', `package emb
type Base struct{}
func (b *Base) Get() string { return "" }
type Wrap struct{ Base }
func (w *Wrap) Do() string { return w.Get() }
`);
  write('internal/rival/rival.go', `package rival
type Rival struct{}
func (r *Rival) Get() string { return "" }
`);
  write('web/boot.ts', `import { Engine } from './engine';
const e = new Engine();
e.start();
`);
  write('web/engine.ts', `export class Engine { start() {} }
export class Motor { start() {} }
`);
}

describe('the gap report finds gaps recorded under another name', () => {
  it('reports a call recorded under a shadowed package name', async () => {
    writeHidingFixture();
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // The call is recorded as "config.ToKeywords" because a local variable shadows
    // the imported package. Asking about the method by qname must still find it.
    const rows = store.gapsFor('related.IndexConfig.ToKeywords');
    const row = rows.find((r) => r.file === 'internal/related/related.go');
    expect(row).toBeTruthy();
    expect(row.dst_name).toBe('config.ToKeywords');
    expect(row.reason).toBe('ambiguous');
    store.close();
  }, 30000);

  it('reports a failed own-receiver guess for a promoted method', async () => {
    writeHidingFixture();
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // emb.Wrap embeds a repo type, so Pass C links it. Break that by making the
    // embedded type external-only, leaving a gap recorded as "emb.Wrap.Get".
    write('internal/emb/emb.go', `package emb
import "sync"
type Wrap struct{ sync.Mutex }
func (w *Wrap) Do() string { return w.Get() }
`);
    await indexFull({ root: dir, store, ignorePatterns: [] });

    const rows = store.gapsFor('rival.Rival.Get');
    const row = rows.find((r) => r.file === 'internal/emb/emb.go');
    expect(row).toBeTruthy();
    expect(row.dst_name).toBe('emb.Wrap.Get');
    expect(row.reason).toBe('ambiguous');
    store.close();
  }, 30000);

  it('reports a resolved call site that sits outside any indexed symbol', async () => {
    writeHidingFixture();
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // `e.start()` is at module scope in boot.ts: resolved, but callers() cannot
    // show a caller row for it.
    expect(store.callers('Engine.start')).toEqual([]);
    const rows = store.gapsFor('Engine.start');
    const row = rows.find((r) => r.file === 'web/boot.ts');
    expect(row).toBeTruthy();
    expect(row.reason).toBe('no-caller');
    store.close();
  }, 30000);

  it('separates calls that leave the repo from calls that may have a target here', async () => {
    write('a/a.go', `package a
import "fmt"
type T struct{}
func (t *T) Println() {}
func (t *T) Do() { fmt.Println("x"); _ = len("y") }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    const rows = store.gapsFrom('a.T.Do');
    const reasons = rows.map((r) => r.reason).sort();
    // fmt.Println has no repo candidate; len is a builtin marked external.
    expect(reasons).toEqual(['external', 'external']);
    store.close();
  }, 30000);

  it('flags a same-name gap in a file that cannot see the target package', async () => {
    write('logs/logs.go', `package logs
type Adapter struct{}
func (a *Adapter) Errorf(f string, v ...any) {}
`);
    write('far/far_test.go', `package far
import "testing"
func TestX(t *testing.T) { t.Errorf("boom") }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    const rows = store.gapsFor('logs.Adapter.Errorf');
    const row = rows.find((r) => r.file === 'far/far_test.go');
    expect(row).toBeTruthy();
    expect(row.reachable).toBe(0); // far/ never imports logs/
    store.close();
  }, 30000);
});
```

Keep the four existing tests in that file, renaming the calls: `unresolvedFor` → `gapsFor`, `unresolvedFrom` → `gapsFrom`, `unresolvedAround` → `gapsAround`.

- [ ] **Step 2: Run the test and watch it fail**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/store-unresolved.test.ts
```

Expected: `TypeError: store.gapsFor is not a function` on every new test, and the same on the four renamed ones.

- [ ] **Step 3: Implement the gap report**

In `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs`, inside `attachReadHelpers`, replace the whole `unresolvedByNames` / `targetNames` / `store.unresolvedFor` / `store.unresolvedFrom` / `store.unresolvedAround` block with:

```js
  // Where an answer is incomplete. Queries walk resolved edges only, so without
  // this a dropped call site and "nothing calls this" print the same thing.
  // `reason`:
  //   'ambiguous' — an unresolved call whose bare name matches a repo symbol, so
  //                 a real target may exist and be missing from the answer
  //   'external'  — an unresolved call with no repo candidate at all (stdlib,
  //                 third party, Go builtin): expected, counted, not worth listing
  //   'no-caller' — a RESOLVED call to the target made outside any indexed symbol
  //                 (module scope, a callback body), which `callers` cannot show
  // `reachable` is 0 only for a Go 'ambiguous' row in a file that neither belongs
  // to nor imports the target's package: a same-name coincidence is then far more
  // likely than a real call. Everything else is 1, including all non-Go rows.
  const gapRows = db.prepare(`
    SELECT e.dst_name, e.dst_bare, e.file, e.line, e.external, e.lang,
           s.qname AS src_qname,
           CASE WHEN e.external = 1 THEN 0 ELSE (
             SELECT count(*) FROM nodes n
             WHERE n.name = e.dst_bare AND n.lang = e.lang
               AND n.kind IN ('function','method','class')) END AS candidates
    FROM edges e LEFT JOIN nodes s ON s.id = e.src_id
    WHERE e.kind = 'call' AND e.dst_id IS NULL
      AND (e.dst_name = ? OR e.dst_bare = ?)`);
  const noCallerRows = db.prepare(`
    SELECT e.dst_name, e.file, e.line FROM edges e
    WHERE e.kind = 'call' AND e.dst_id = ? AND e.src_id IS NULL`);
  const fileInPackage = db.prepare(
    `SELECT 1 FROM nodes WHERE file = ? AND qname LIKE ? LIMIT 1`);
  const fileImportsPackage = db.prepare(`
    SELECT 1 FROM edges WHERE kind = 'import' AND file = ?
      AND (dst_name LIKE ? OR dst_name LIKE ?) LIMIT 1`);

  // The Go package a symbol lives in is the first segment of its qname.
  const goPackageOf = (node) =>
    node && node.lang === 'go' && node.qname.includes('.') ? node.qname.split('.')[0] : null;

  const reachableIn = (file, pkg) => {
    if (!pkg) return 1;
    if (fileInPackage.get(file, `${pkg}.%`)) return 1;
    // Import paths are stored quoted: "x/internal/bufferpool" or "bufferpool".
    if (fileImportsPackage.get(file, `%/${pkg}"`, `"${pkg}"`)) return 1;
    return 0;
  };

  const collectGaps = (names, target) => {
    const pkg = goPackageOf(target);
    const seen = new Set(), out = [];
    for (const name of new Set(names.filter(Boolean).map(String))) {
      for (const r of gapRows.all(name, name)) {
        const key = `${r.file}|${r.line}|${r.dst_name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const reason = r.candidates > 0 ? 'ambiguous' : 'external';
        out.push({
          file: r.file, line: r.line, dst_name: r.dst_name, src_qname: r.src_qname,
          reason,
          reachable: reason === 'ambiguous' && r.lang === 'go' ? reachableIn(r.file, pkg) : 1,
        });
      }
    }
    if (target) {
      for (const r of noCallerRows.all(target.id)) {
        const key = `${r.file}|${r.line}|${r.dst_name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ file: r.file, line: r.line, dst_name: r.dst_name,
          src_qname: null, reason: 'no-caller', reachable: 1 });
      }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  };

  // A call site records whatever the source wrote, so match the target's bare
  // name as well as its qname — that is what finds a call made through an import
  // alias, a shadowed package name, or a receiver-qualified guess that missed.
  store.gapsFor = (name) => {
    const target = store.node(name);
    return collectGaps(target ? [String(name), target.name, target.qname] : [String(name)], target);
  };
  store.gapsFrom = (name) => {
    const n = store.node(name);
    if (!n) return [];
    return db.prepare(`
      SELECT e.dst_name, e.dst_bare, e.file, e.line, e.external, e.lang,
             (SELECT count(*) FROM nodes n2
              WHERE n2.name = e.dst_bare AND n2.lang = e.lang
                AND n2.kind IN ('function','method','class')) AS candidates
      FROM edges e WHERE e.kind = 'call' AND e.dst_id IS NULL AND e.src_id = ?
      ORDER BY e.file, e.line`).all(n.id).map((r) => ({
        file: r.file, line: r.line, dst_name: r.dst_name, src_qname: n.qname,
        reason: r.external === 1 || r.candidates === 0 ? 'external' : 'ambiguous',
        reachable: 1,
      }));
  };
  // The frontier of an impact walk: gaps naming the target AND gaps naming
  // anything the walk already reached, which is where it stopped.
  store.gapsAround = (name) => {
    const target = store.node(name);
    const names = target ? [String(name), target.name, target.qname] : [String(name)];
    const reached = store.impact(name);
    for (const n of reached) { names.push(n.name, n.qname); }
    const rows = collectGaps(names, target);
    for (const n of reached) {
      for (const r of noCallerRows.all(n.id)) {
        rows.push({ file: r.file, line: r.line, dst_name: r.dst_name,
          src_qname: null, reason: 'no-caller', reachable: 1 });
      }
    }
    const seen = new Set();
    return rows.filter((r) => {
      const key = `${r.file}|${r.line}|${r.dst_name}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  };
```

- [ ] **Step 4: Run the test and the whole suite**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/store-unresolved.test.ts
npx vitest run plugins/p-graph
```

Expected: the store tests pass. `cli-unresolved.test.ts` now fails — the CLI still calls `unresolvedFor`. That is Task 6. To keep the suite green at this commit, do the rename in `commands.mjs` now (`unresolvedFor` → `gapsFor`, `unresolvedFrom` → `gapsFrom`, `unresolvedAround` → `gapsAround`) and leave the output format alone.

- [ ] **Step 5: Commit**

```powershell
git add plugins/p-graph/tools/lib/destinations/local-sqlite.mjs plugins/p-graph/tools/lib/cli/commands.mjs plugins/p-graph/tools/__tests__/store-unresolved.test.ts
git commit -m "fix(p-graph): find gaps recorded under an alias, a missed guess, or no enclosing symbol"
```

---

### Task 6: A banner people will actually read

`callers loggers.logAdapter.Errorf` printed 387 gap lines, 365 of them `t.Errorf` from the test framework. Group the rows, list only the ones that may be real, and always print the exact totals.

**Files:**
- Modify: `plugins/p-graph/tools/lib/cli/commands.mjs`
- Modify: `plugins/p-graph/tools/__tests__/cli-unresolved.test.ts`

**Interfaces:**
- Consumes: `store.gapsFor` / `gapsFrom` / `gapsAround` from Task 5.
- Produces: `callers`/`callees`/`impact` with `--json` return `{ <command>: [rows], gaps: [gap rows] }` — the key is renamed from `unresolved` to `gaps` because the rows now include resolved-but-callerless sites. `context --json` returns `gaps_in` / `gaps_out`. Text output prints at most 20 listed rows plus one summary line per suppressed group.

- [ ] **Step 1: Write the failing test**

In `plugins/p-graph/tools/__tests__/cli-unresolved.test.ts`, keep the existing fixture and tests (renaming the JSON key `unresolved` → `gaps`), and add:

```ts
  it('lists likely gaps and only counts the noisy ones', () => {
    // logs.Adapter.Errorf shares its name with testing.T.Errorf, called from a
    // package that never imports logs/.
    write('logs/logs.go', `package logs
type Adapter struct{}
func (a *Adapter) Errorf(f string, v ...any) {}
`);
    write('far/far_test.go', `package far
import "testing"
func TestA(t *testing.T) { t.Errorf("a") }
func TestB(t *testing.T) { t.Errorf("b") }
`);
    run(['index', '--full']);
    const text = run(['callers', 'logs.Adapter.Errorf']);
    expect(text).toContain('2 same-name call sites in files that do not import');
    expect(text).not.toContain('far/far_test.go:2');   // counted, not listed
  }, 30000);

  it('counts calls that leave the repo without listing them', () => {
    write('svc/svc.go', `package svc
import "fmt"
func Do() { fmt.Println("x") }
`);
    run(['index', '--full']);
    const text = run(['callees', 'svc.Do']);
    expect(text).toContain('1 call that leaves the repo');
    expect(text).not.toContain('svc/svc.go:3');
  }, 30000);

  it('names a resolved call site that has no caller row', () => {
    write('web/engine.ts', 'export class Engine { start() {} }');
    write('web/boot.ts', "import { Engine } from './engine';\nnew Engine().start();");
    run(['index', '--full']);
    const text = run(['callers', 'Engine.start']);
    expect(text).toContain('web/boot.ts:2');
    expect(text).toContain('outside any indexed symbol');
  }, 30000);
```

- [ ] **Step 2: Run the test and watch it fail**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/cli-unresolved.test.ts
```

Expected: the three new tests fail on the missing summary wording; the renamed JSON tests fail with `expected undefined to deeply equal []` until Step 3 renames the key.

- [ ] **Step 3: Rewrite the banner**

In `plugins/p-graph/tools/lib/cli/commands.mjs`, replace `emitGaps` with:

```js
  // Name the call sites this answer is missing, without burying them. A gap that
  // shares a name with the target but sits in a file that cannot even see the
  // target's package is almost always a coincidence, and a call that leaves the
  // repo can never be linked — both are counted honestly and not listed, because
  // a banner nobody reads is worse than none.
  const GAP_LIMIT = 20;
  const emitGaps = (rows) => {
    const listed = rows.filter((r) => r.reason !== 'external' && r.reachable !== 0);
    const unrelated = rows.filter((r) => r.reason === 'ambiguous' && r.reachable === 0).length;
    const external = rows.filter((r) => r.reason === 'external').length;
    if (!listed.length && !unrelated && !external) return;
    if (listed.length) {
      out(`⚠ ${listed.length} call site${listed.length === 1 ? '' : 's'} missing from this answer:`);
      for (const r of listed.slice(0, GAP_LIMIT)) {
        const where = r.reason === 'no-caller'
          ? 'outside any indexed symbol'
          : (r.src_qname ?? 'file scope');
        out(`    ${r.file}:${r.line}  ${where} -> ${r.dst_name}`);
      }
      if (listed.length > GAP_LIMIT) out(`    … and ${listed.length - GAP_LIMIT} more`);
    }
    if (unrelated) {
      out(`  + ${unrelated} same-name call site${unrelated === 1 ? '' : 's'} in files that do not import the target's package — likely unrelated.`);
    }
    if (external) {
      out(`  + ${external} call${external === 1 ? '' : 's'} that leave${external === 1 ? 's' : ''} the repo (stdlib, third party, builtins) — nothing to link.`);
    }
    out('  Confirm with a text search before treating this answer as complete.');
  };
```

Then rename the JSON keys in the four commands. `callers`:

```js
  if (command === 'callers') {
    const target = opts._[0];
    const rows = store.callers(target), gaps = store.gapsFor(target);
    if (opts.json) return emitJson({ callers: rows, gaps });
    rows.forEach((r) => out(fmtNode(r)));
    return emitGaps(gaps);
  }
```

`callees` uses `store.gapsFrom(target)` and `{ callees: rows, gaps }` — drop the old `.map((r) => ({ ...r, src_qname: target }))`, because `gapsFrom` now sets `src_qname` itself. `impact` uses `store.gapsAround(target)` and `{ impact: rows, gaps }`. `context` uses `gaps_in: store.gapsFor(...)`, `gaps_out: store.gapsFrom(...)` and passes `[...gaps_in, ...gaps_out]` to `emitGaps`.

- [ ] **Step 4: Run the test and the whole suite**

```powershell
npx vitest run plugins/p-graph/tools/__tests__/cli-unresolved.test.ts
npx vitest run plugins/p-graph
```

Expected: all green. `cli-query-graph.test.ts`, `cli-autorefresh.test.ts` and `cli-concurrency.test.ts` read `.callers` and are unaffected by the `unresolved` → `gaps` rename.

- [ ] **Step 5: Read the output with your own eyes**

Build the noisy case and look at it:

```bash
D="$TMPDIR/pg-banner"; rm -rf "$D"; mkdir -p "$D/.git" "$D/.pgraph" "$D/logs" "$D/far"
printf 'package logs\ntype Adapter struct{}\nfunc (a *Adapter) Errorf(f string, v ...any) {}\n' > "$D/logs/logs.go"
printf 'package far\nimport "testing"\nfunc TestA(t *testing.T) { t.Errorf("a") }\n' > "$D/far/far_test.go"
cd "$D" && node /c/projects/perky.team/claude-plugin/plugins/p-graph/tools/pgraph.mjs index --full >/dev/null 2>&1
node /c/projects/perky.team/claude-plugin/plugins/p-graph/tools/pgraph.mjs callers logs.Adapter.Errorf 2>/dev/null
```

Expected: no listed rows, one `+ 1 same-name call site in files that do not import the target's package — likely unrelated.` line, and the closing advice. If a wall of `t.Errorf` lines still appears, `reachable` is not being computed — check `goPackageOf` against the target's `lang`.

- [ ] **Step 6: Commit**

```powershell
git add plugins/p-graph/tools/lib/cli/commands.mjs plugins/p-graph/tools/__tests__/cli-unresolved.test.ts
git commit -m "fix(cli): group the gap report so the real misses are visible"
```

---

### Task 7: Documentation that matches the measurements

The README currently says p-graph "never invents a false edge" and tells users to "prefer these over grep". Both are wrong, and they are the reason the tool got trusted where it should not have been.

**Files:**
- Modify: `plugins/p-graph/README.md:96-115` (the "Name resolution" and "Incompleteness is reported" sections)
- Modify: `plugins/p-graph/skills/query/SKILL.md`
- Modify: `plugins/p-graph/skills/help/SKILL.md`
- Modify: `plugins/p-graph/skills/_shared/templates/p-graph-rule.template.md`

**Interfaces:**
- Consumes: the behaviour from Tasks 1-6. The precision figures below are the ones the evaluation measured **before** this plan; Task 8 replaces them with fresh ones.
- Produces: no code interface.

- [ ] **Step 1: Replace the false claim in `README.md`**

Find the sentence starting `Each symbol carries a bare \`name\`` and replace the clause `— \`pgraph\` never invents a false edge, because a wrong edge would make \`impact\`/\`callers\`/\`trace\` lie.` with:

```markdown
— an ambiguous name is left **unresolved** rather than linked to a guess. That guard is not a proof of correctness: the resolver matches names, not types, so a bare name that is unique in the repo still links even when the real receiver is a standard-library type. Measured on gohugoio/hugo, exact qualified matches were correct in 18 of 18 hand-checked cases and bare-name matches in 20 of 22. Treat a `callers` row as a strong lead, not as a fact.
```

- [ ] **Step 2: Replace the grep advice in `README.md`**

Find the line that tells the reader to prefer the graph over grep and replace it with:

```markdown
Use the graph to find candidates fast and to get a transitive `impact` sketch in one call. Use grep to confirm a count: on a 900-file Go repo a text search costs about the same as a graph query, and it cannot silently omit a hit.
```

- [ ] **Step 3: Document the new gap categories in `README.md`**

In the "Incompleteness is reported, not hidden" section, replace the sample output block with:

```markdown
⚠ 3 call sites missing from this answer:
    internal/api/server.go:41  api.Server.HandleList -> ListGroups
    internal/api/server.go:58  api.Serve -> bp.ListGroups
    web/boot.ts:12  outside any indexed symbol -> start
  + 12 same-name call sites in files that do not import the target's package — likely unrelated.
  + 365 calls that leave the repo (stdlib, third party, builtins) — nothing to link.
  Confirm with a text search before treating this answer as complete.
```

and add below it:

```markdown
A gap is matched by the **bare name** each call site actually wrote, not by the name you asked about. That is what finds a call made through an import alias (`bp.ListGroups` for `bufferpool.ListGroups`), through a local variable that shadows a package name, or through a receiver-qualified guess whose target does not exist. Three groups are reported separately, so the list stays short enough to read: call sites that may be a real miss are listed; same-name call sites in files that cannot even see the target's package are counted; and calls that leave the repo are counted. `--json` returns every row with its `reason` and `reachable` fields.

`callers` also cannot show a caller row for a call made outside any indexed symbol — at module scope, or inside a callback that is not a definition. Those call sites are resolved in the graph but have no source symbol, so they appear in the gap report as `outside any indexed symbol` instead of vanishing.
```

- [ ] **Step 4: Update `skills/query/SKILL.md`**

In "Step 3 — Report the gaps, always", replace the sample block with the one from Step 3 above, and replace the paragraph beginning `**You MUST pass this on to the user** …` with:

```markdown
**You MUST pass this on to the user whenever it appears** — the listed `file:line` rows and both counts. Never present a list as complete while the banner is there. The listed rows are the ones worth checking by hand; the two counted groups are for scale, and you should say what they are rather than hiding them.

A resolved row is a strong lead, not a fact: the graph matches names, not types. If the user's question is "did I find every call site?" or "is this safe to change?", the honest answer is: here is what the graph found, here is where it gave up — now confirm with a text search.
```

In the `--json` line, change `{ <command>: [rows], unresolved: [gaps] }` to `{ <command>: [rows], gaps: [gap rows] }`.

- [ ] **Step 5: Update `skills/help/SKILL.md` and the rule template**

In both files, change the banner wording from `⚠ N unattributed call sites` to `⚠ N call sites missing from this answer`, and add one line: `Gaps are grouped — listed rows are worth checking, the two counted groups are scale.`

- [ ] **Step 6: Verify the docs against the code**

```powershell
npx vitest run tests/plugin-manifests.test.ts
npm run validate
Select-String -Path plugins/p-graph/README.md,plugins/p-graph/skills/**/SKILL.md -Pattern "never invents|prefer these over grep|unattributed"
```

Expected: manifests and validate pass; the `Select-String` finds nothing. Any hit is a claim you did not update.

- [ ] **Step 7: Commit**

```powershell
git add plugins/p-graph/README.md plugins/p-graph/skills
git commit -m "docs(p-graph): replace the no-false-edge claim with measured precision and document the gap groups"
```

---

### Task 8: Re-measure on real repositories

Every number in this plan came from a measurement. Close the loop: prove the defects are gone on the same corpora, and put the new figures in the docs.

**Files:**
- Create: `plugins/p-graph/docs/superpowers/plans/2026-07-31-p-graph-trustworthy-answers-results.md`
- Modify: `plugins/p-graph/README.md` (fill in the measured precision figures)

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: a results document with before/after numbers; no code interface.

- [ ] **Step 1: Index hugo and record the totals**

```bash
cd "$TMPDIR" && rm -rf hugo-eval && git clone --depth 1 https://github.com/gohugoio/hugo hugo-eval
cd hugo-eval && mkdir -p .pgraph
CLI=/c/projects/perky.team/claude-plugin/plugins/p-graph/tools/pgraph.mjs
time node "$CLI" index --full
node "$CLI" status
```

Record: files, nodes, edges, `unattributed calls N/M`, wall time, and `.pgraph/graph.db` size. Reference before this plan: 928 files, 9882 nodes, 55402 call edges, 38740 unattributed (69.9%), 19.5 s, 68.0 MB.

- [ ] **Step 2: Prove the false-edge classes are gone**

```bash
node --input-type=module -e "
import {openStore} from 'file:///C:/projects/perky.team/claude-plugin/plugins/p-graph/tools/lib/destinations/local-sqlite.mjs';
const s = openStore('.pgraph/graph.db', {readOnly: true});
const q = (sql) => s.db.prepare(sql).get().c;
console.log('cross-language:', q(\"SELECT count(*) c FROM edges e JOIN nodes s ON s.id=e.src_id JOIN nodes d ON d.id=e.dst_id WHERE s.lang <> d.lang\"));
console.log('into a type/struct:', q(\"SELECT count(*) c FROM edges e JOIN nodes d ON d.id=e.dst_id WHERE e.kind='call' AND d.kind IN ('type','struct','interface','enum')\"));
console.log('resolved builtins:', q(\"SELECT count(*) c FROM edges WHERE external=1 AND dst_id IS NOT NULL\"));
console.log('resolved imports:', q(\"SELECT count(*) c FROM edges WHERE kind='import' AND dst_id IS NOT NULL\"));
s.close();"
```

Expected: all four are `0`. Reference before this plan: 163, 235, 101, unknown.

- [ ] **Step 3: Re-run the two queries that lied**

```bash
node "$CLI" callers bufferpool.GetBuffer
grep -rn "GetBuffer()" --include=*.go . | wc -l
node "$CLI" callers highlight.byteCountFlexiWriter.WriteRune
node "$CLI" callers loggers.logAdapter.Errorf
```

Expected:
- `GetBuffer`: **around 24 caller rows, not 3.** Task 3 translates the `bp` alias, so the 21 previously-lost call sites are now resolved rather than merely reported. Compare against the `grep | wc -l` count and account for every difference — a hit inside a comment or a string is a legitimate difference, a missing real call is not.
- `WriteRune`: **zero** caller rows (all 13 were false), with a banner instead.
- `Errorf`: zero or few rows, and the `t.Errorf` mass reported as a single `same-name call sites in files that do not import` count instead of 365 lines.

- [ ] **Step 4: Confirm the incremental/full agreement on a real repo**

```bash
node "$CLI" index --full >/dev/null && node "$CLI" status > /tmp/full.txt
printf 'package main\nfunc probeSymbol() {}\n' > probe.go
node "$CLI" index >/dev/null && node "$CLI" status > /tmp/inc.txt
rm probe.go && node "$CLI" index >/dev/null && node "$CLI" status
diff /tmp/full.txt <(node "$CLI" status) || echo "DIVERGED"
```

Expected: after removing the probe file and reindexing, `status` matches the original full-index line except for `sha`/`drift`. Any other difference means resolution is still order-dependent.

- [ ] **Step 5: Repeat the totals for nest and flask**

```bash
cd "$TMPDIR" && git clone --depth 1 https://github.com/nestjs/nest nest-eval && cd nest-eval && mkdir -p .pgraph && node "$CLI" index --full && node "$CLI" status
cd "$TMPDIR" && git clone --depth 1 https://github.com/pallets/flask flask-eval && cd flask-eval && mkdir -p .pgraph && node "$CLI" index --full && node "$CLI" status
```

For nest, also check that the callerless call sites now surface:

```bash
node "$CLI" callers TestingModule.createNestApplication
```

Expected: the 6 caller rows as before, plus a banner naming the module-scope and callback call sites (184 before this plan, reported as `outside any indexed symbol`). Reference: nest had 5112 resolved edges with no source symbol, 56.3% of all resolved edges.

- [ ] **Step 6: Hand-check precision on a fresh sample**

Pick 20 resolved Go edges at random and read the source of each call site to confirm the target:

```bash
cd "$TMPDIR/hugo-eval" && node --input-type=module -e "
import {openStore} from 'file:///C:/projects/perky.team/claude-plugin/plugins/p-graph/tools/lib/destinations/local-sqlite.mjs';
const s = openStore('.pgraph/graph.db', {readOnly: true});
for (const r of s.db.prepare(\"SELECT e.file, e.line, e.dst_name, d.qname, d.file AS dfile, d.start_line FROM edges e JOIN nodes d ON d.id=e.dst_id WHERE e.kind='call' AND d.lang='go' ORDER BY e.rowid LIMIT 400\").all().filter((_, i) => i % 20 === 0)) console.log(r);
s.close();"
```

For each row, open `file:line` and confirm the call really targets `qname`. Record correct/false counts. A single false edge is a finding: write down its class and whether a cheap guard would catch it.

- [ ] **Step 7: Write the results document**

Create `plugins/p-graph/docs/superpowers/plans/2026-07-31-p-graph-trustworthy-answers-results.md` with: a before/after table for the three corpora (files, call edges, unattributed share, timings, DB size), the four false-edge counts from Step 2, the three re-run queries from Step 3 with their real output, the precision sample from Step 6, and an explicit list of anything that did **not** improve.

- [ ] **Step 8: Put the real numbers in the README**

Replace the pre-plan precision sentence written in Task 7 Step 1 with the figures from Step 6 of this task, in the form: `Measured on gohugoio/hugo at <sha>: exact qualified matches were correct in N of N hand-checked cases, bare-name matches in N of N.`

- [ ] **Step 9: Commit**

```powershell
git add plugins/p-graph/docs/superpowers/plans/2026-07-31-p-graph-trustworthy-answers-results.md plugins/p-graph/README.md
git commit -m "docs(p-graph): record the measured before/after for the trustworthy-answers work"
```

---

## Release note (do not perform as part of this plan)

After all seven tasks are green, the release procedure in `.claude/CLAUDE.md` applies. The expected bump for this work plus the two changes already on `main`:

- `p-graph` `0.7.1 → 0.8.0` (minor). The graph's answers change shape (`--json` key `unresolved` → `gaps`, and the arrays became objects in the previous change), but the only consumer is the skill that ships in the same plugin. If you would rather treat the `--json` contract as public, make it `1.0.0`.
- Monorepo tag: one minor bump above the current highest tag.
- `SCHEMA_VERSION` 6 forces one automatic full reindex for every existing user on their next query.

## Follow-up work this plan deliberately leaves out

1. **C++ out-of-line methods.** `cpp.scm` matches `function_definition` with an `identifier` or `field_identifier` declarator. The normal layout — declare in `.h`, define as `std::string PgStore::Get(int)` in `.cpp` — uses a `qualified_identifier` declarator and a header `field_declaration`, so both are missed: 2 of 4 files in a small test corpus produced zero symbols. Until this is fixed, C++ support is weaker than the README implies.
2. **TS/JS calls inside callbacks.** `describe`/`it`/`beforeEach` callbacks are not definitions, so 394 of nest's 1727 files produced zero symbols and 56.3% of resolved edges have no source symbol. Task 5 makes those call sites visible in the gap report; it does not give them a caller. Capturing call-argument function bodies as definitions would.
3. **Interface dispatch.** Indexing interface method declarations and adding `implements` edges (a type whose method set covers the interface) would turn "the graph gave up" into "here are the 5 possible targets". This is the largest remaining gap versus a type-aware tool, and it needs its own design: the current model assumes one target per call.
