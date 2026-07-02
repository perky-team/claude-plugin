# p-graph auto-refresh on query — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pgraph` structural queries auto-refresh the code graph before answering, so a query never answers from a stale graph — with no hook and no background watcher.

**Architecture:** A freshness gate runs before every query command. It computes git-based "actionable" drift (only files the graph indexes). If drift > 0 and auto-refresh is enabled, it reindexes the changed files in place under an exclusive lock file, relying on SQLite's atomic WAL commit, then answers from the fresh graph. When drift is 0 the query path is unchanged. Refresh is best-effort; a query always returns an answer (graceful degradation + a staleness banner on stderr).

**Tech Stack:** Node ≥ 22.5, `node:sqlite` (built-in), tree-sitter WASM (existing), Vitest.

## Global Constraints

- **Node ≥ 22.5** — uses built-in `node:sqlite`. No new npm dependencies.
- **All Claude Code artifacts in English** (skills, templates, README, rule).
- **Commit messages carry no Claude attribution** — no `Co-Authored-By`, no "Generated with" footer.
- **Runs on Windows** (PowerShell is the user's shell). No POSIX-only assumptions in shipped code.
- **Exact known-drift banner text** (stderr, verbatim): `⚠ p-graph STALE: N files changed since index; results may be wrong. Run /p-graph:sync`
- **Exact unknown-drift banner text** (stderr, verbatim): `⚠ p-graph STALE: cannot verify freshness (not a git checkout); results may be wrong. Run /p-graph:sync`
- **Observability note** (stderr, verbatim): `p-graph: refreshing N changed files…` (or `p-graph: rebuilding graph after schema upgrade…` when a stale schema forces a full rebuild).
- **stdout stays clean** — only the query result / JSON. All notes and banners go to **stderr**.
- **Version bump:** `plugins/p-graph/.claude-plugin/plugin.json` `0.3.1 → 0.4.0` (minor). **Do NOT tag or publish** — the maintainer releases.
- Query commands (the ones the gate applies to): `search`, `node`, `callers`, `callees`, `impact`, `trace`, `context`, `explore`, `files`. **Never** `index` or `status`.
- Run tests from the repo root: `npx vitest run <path>`.

---

## File structure

- `tools/lib/index/build.mjs` — **modify.** `indexFile` returns a skip flag and skips unchanged files by content hash; `indexChanged` counts only real reparses and calls `resolvePending` only when something changed; export `headSha`.
- `tools/lib/destinations/local-sqlite.mjs` — **modify.** Add `store.fileHash(path)`; add a read-only open branch to `openStore`.
- `tools/lib/destination.mjs` — **modify.** Thread a `{ readOnly }` option through to `openStore`.
- `tools/lib/index/lock.mjs` — **create.** `withReindexLock`, `pidAlive` (exclusive lock file, pid-liveness + timestamp stale detection).
- `tools/lib/freshness.mjs` — **create.** `ensureFresh(ctx)`, `computeActionable`, `driftCount`, banner strings.
- `tools/lib/cli/commands.mjs` — **modify.** Call `await ensureFresh(ctx)` at the top of `runCommand`; import `headSha` from `build.mjs` instead of defining it locally.
- `tools/pgraph.mjs` — **modify.** Parse `PGRAPH_AUTOREFRESH`; add `warn` + `pgraphDir` to ctx; read-only store-open fallback.
- `tools/__tests__/index-hashskip.test.ts` — **create.** Hash-skip + resolvePending-skip.
- `tools/__tests__/reindex-lock.test.ts` — **create.** Lock acquire / contended / stale-steal / pidAlive.
- `tools/__tests__/cli-autorefresh.test.ts` — **create.** Acceptance: auto-refresh, fast path, actionable filter, opt-out, non-git degrade, status unchanged.
- `tools/__tests__/cli-concurrency.test.ts` — **create.** Two parallel queries after a committed change.
- Docs — **modify.** `skills/_shared/templates/p-graph-rule.template.md`, `skills/_shared/templates/pgraph-claude-md.template.md`, `README.md`, `skills/sync/SKILL.md`.
- `.claude-plugin/plugin.json` — **modify.** Version bump.

All library paths below are relative to `plugins/p-graph/`.

---

## Task 1: Content-hash skip + conditional resolvePending

**Files:**
- Modify: `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs` (add `store.fileHash`)
- Modify: `plugins/p-graph/tools/lib/index/build.mjs` (`indexFile` skip + return flag; `indexChanged` counting + resolvePending guard; export `headSha`)
- Test: `plugins/p-graph/tools/__tests__/index-hashskip.test.ts`

**Interfaces:**
- Produces: `store.fileHash(path: string): string | null` — the sha1 stored for a file, or null.
- Produces: `indexFile(root, store, rel): Promise<boolean>` — `true` if it parsed+wrote, `false` if skipped as unchanged.
- Produces: `indexChanged(...)` still returns `{ changed, deleted, skipped }`, where `changed` now counts only files actually reparsed.
- Produces: `headSha(root: string): string | null` (exported from `build.mjs`).

- [ ] **Step 1: Write the failing test**

Create `plugins/p-graph/tools/__tests__/index-hashskip.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull, indexChanged } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('content-hash skip', () => {
  it('store.fileHash returns the stored hash after indexing', async () => {
    writeFileSync(join(dir, 'a.ts'), 'function foo() {}');
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });
    expect(store.fileHash('a.ts')).toMatch(/^[0-9a-f]{40}$/);
    expect(store.fileHash('missing.ts')).toBeNull();
    store.close();
  });

  it('indexChanged skips a file whose content is unchanged', async () => {
    writeFileSync(join(dir, 'a.ts'), 'function foo() {}');
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // Re-run with a.ts in the modified list but content unchanged.
    const res = await indexChanged({
      root: dir, store, ignorePatterns: [],
      changedFiles: () => ({ modified: ['a.ts'], deleted: [] }),
    });
    expect(res.changed).toBe(0); // skipped, not reparsed

    // Now change the content: it must reparse.
    writeFileSync(join(dir, 'a.ts'), 'function foo() {}\nfunction baz() {}');
    const res2 = await indexChanged({
      root: dir, store, ignorePatterns: [],
      changedFiles: () => ({ modified: ['a.ts'], deleted: [] }),
    });
    expect(res2.changed).toBe(1);
    expect(store.node('baz')).toBeTruthy();
    store.close();
  });

  it('resolvePending runs only when something was reparsed or deleted', async () => {
    writeFileSync(join(dir, 'a.ts'), 'function foo() {}');
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    let calls = 0;
    const orig = store.resolvePending;
    store.resolvePending = () => { calls++; return orig(); };

    // No real change -> resolvePending must NOT run.
    await indexChanged({
      root: dir, store, ignorePatterns: [],
      changedFiles: () => ({ modified: ['a.ts'], deleted: [] }),
    });
    expect(calls).toBe(0);

    // A deletion -> resolvePending MUST run.
    await indexChanged({
      root: dir, store, ignorePatterns: [],
      changedFiles: () => ({ modified: [], deleted: ['gone.ts'] }),
    });
    expect(calls).toBe(1);
    store.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-graph/tools/__tests__/index-hashskip.test.ts`
Expected: FAIL — `store.fileHash is not a function` / `res.changed` is `1` not `0`.

- [ ] **Step 3: Add `store.fileHash` to the store**

In `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs`, inside `openStore`, next to the other `store.*` read helpers (e.g. right after `store.node = ...` near line 140), add:

```js
  store.fileHash = (path) =>
    db.prepare('SELECT hash FROM files WHERE path = ?').get(path)?.hash ?? null;
```

- [ ] **Step 4: Make `indexFile` skip unchanged files and report it**

In `plugins/p-graph/tools/lib/index/build.mjs`, replace the whole `indexFile` function (lines ~20-28) with:

```js
export async function indexFile(root, store, rel) {
  const cfg = resolveLang(rel);
  if (!cfg) return false;
  const source = readFileSync(join(root, rel), 'utf-8');
  const hash = createHash('sha1').update(source).digest('hex');
  // Skip files whose content is unchanged since the last index. `indexFull`
  // calls store.clear() first (files table truncated), so fileHash is null there
  // and every file is fully parsed; only incremental runs skip.
  if (store.fileHash?.(rel) === hash) return false;
  const { nodes, edges } = await extract({ file: rel, lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source });
  store.upsertFile(rel, hash, cfg.lang);
  store.replaceFileSymbols(rel, nodes, edges);
  return true;
}
```

- [ ] **Step 5: Count only real reparses and guard `resolvePending` in `indexChanged`**

In `plugins/p-graph/tools/lib/index/build.mjs`, in `indexChanged` (the loop near lines ~91-103), replace the modified-loop and the tail with:

```js
  let n = 0, skipped = 0;
  for (const rel of change.modified) {
    if (isIgnored(rel, ignorePatterns) || !resolveLang(rel)) continue;
    try {
      if (await indexFile(root, store, rel)) n++;
    } catch (err) {
      skipped++;
      onError?.(rel, err);
    }
  }
  for (const rel of change.deleted) store.removeFile(rel);
  // Edge resolution only changes when nodes are added or removed. If nothing was
  // reparsed and nothing was deleted, the resolution state is already correct, so
  // skip the (full-table) resolvePending scan — this keeps repeat queries over a
  // stable dirty tree cheap.
  if (n > 0 || change.deleted.length > 0) store.resolvePending();
  return { changed: n, deleted: change.deleted.length, skipped };
```

- [ ] **Step 6: Export `headSha` from `build.mjs`**

In `plugins/p-graph/tools/lib/index/build.mjs`, add this exported function (place it just after the imports, before `walk`):

```js
export function headSha(root) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim(); }
  catch { return null; }
}
```

(`execFileSync` is already imported at the top of the file.)

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run plugins/p-graph/tools/__tests__/index-hashskip.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Run the existing index tests to check for regressions**

Run: `npx vitest run plugins/p-graph/tools/__tests__/index-incremental.test.ts plugins/p-graph/tools/__tests__/index-full.test.ts`
Expected: PASS (unchanged behaviour — full index still reparses everything; incremental still reindexes changed files).

- [ ] **Step 9: Commit**

```bash
git add plugins/p-graph/tools/lib/index/build.mjs plugins/p-graph/tools/lib/destinations/local-sqlite.mjs plugins/p-graph/tools/__tests__/index-hashskip.test.ts
git commit -m "feat(p-graph): skip unchanged files by hash; guard resolvePending"
```

---

## Task 2: Reindex lock module

**Files:**
- Create: `plugins/p-graph/tools/lib/index/lock.mjs`
- Test: `plugins/p-graph/tools/__tests__/reindex-lock.test.ts`

**Interfaces:**
- Produces: `pidAlive(pid: number): boolean` — true if the process exists (EPERM counts as alive), false if not (ESRCH).
- Produces: `withReindexLock(pgraphDir: string, opts: { timeoutMs?, staleMs?, pollMs? }, fn: () => Promise<T>): Promise<{ acquired: boolean, result?: T }>` — acquires an exclusive lock file at `<pgraphDir>/reindex.lock`, runs `fn` while held, unlinks on exit. Waits (polling) up to `timeoutMs` when contended; steals a lock whose holder pid is dead or whose timestamp is older than `staleMs`. Returns `{ acquired: false }` on timeout (fn not run).

- [ ] **Step 1: Write the failing test**

Create `plugins/p-graph/tools/__tests__/reindex-lock.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withReindexLock, pidAlive } from '../lib/index/lock.mjs';

let pg;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-'));
  pg = join(dir, '.pgraph');
  mkdirSync(pg);
});
afterEach(() => rmSync(join(pg, '..'), { recursive: true, force: true }));

describe('pidAlive', () => {
  it('is true for the current process and false for an unused pid', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2147483646)).toBe(false); // effectively never a live pid
  });
});

describe('withReindexLock', () => {
  it('acquires, runs fn, and releases the lock', async () => {
    const lockPath = join(pg, 'reindex.lock');
    const r = await withReindexLock(pg, {}, async () => {
      expect(existsSync(lockPath)).toBe(true);
      return 42;
    });
    expect(r).toEqual({ acquired: true, result: 42 });
    expect(existsSync(lockPath)).toBe(false); // released
  });

  it('does not steal a lock held by a live process (times out)', async () => {
    const lockPath = join(pg, 'reindex.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    let ran = false;
    const r = await withReindexLock(pg, { timeoutMs: 150, pollMs: 20 }, async () => { ran = true; });
    expect(r.acquired).toBe(false);
    expect(ran).toBe(false);
  });

  it('steals a stale lock (dead pid) and runs fn', async () => {
    const lockPath = join(pg, 'reindex.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, ts: Date.now() }));
    const r = await withReindexLock(pg, { timeoutMs: 500, pollMs: 20 }, async () => 'ok');
    expect(r).toEqual({ acquired: true, result: 'ok' });
  });

  it('steals a lock whose timestamp is older than staleMs', async () => {
    const lockPath = join(pg, 'reindex.lock');
    // No pid field, old timestamp -> stale by age.
    writeFileSync(lockPath, JSON.stringify({ ts: Date.now() - 999999 }));
    const r = await withReindexLock(pg, { timeoutMs: 500, pollMs: 20, staleMs: 1000 }, async () => 'ok');
    expect(r.acquired).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-graph/tools/__tests__/reindex-lock.test.ts`
Expected: FAIL — cannot import `withReindexLock` / `pidAlive` (module missing).

- [ ] **Step 3: Create the lock module**

Create `plugins/p-graph/tools/lib/index/lock.mjs`:

```js
import { openSync, writeSync, closeSync, unlinkSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// True if the process exists. `process.kill(pid, 0)` sends no signal: it throws
// ESRCH when the process is gone, and EPERM when it exists but we may not signal
// it (still alive). Any other outcome is treated as alive to avoid stealing a
// live holder's lock.
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// A lock is stale if its holder pid is dead, or (when the pid is unknown/partial
// because we caught the holder mid-write) if the file itself is older than
// staleMs. A freshly created lock has a recent mtime, so it is never mistaken for
// stale during the tiny window between create and write.
function isStale(lockPath, staleMs) {
  let raw;
  try { raw = readFileSync(lockPath, 'utf-8'); } catch { return false; }
  let info = null;
  try { info = JSON.parse(raw); } catch { /* partial / empty */ }
  if (info?.pid) return !pidAlive(info.pid);
  if (info?.ts) return Date.now() - info.ts > staleMs;
  try { return Date.now() - statSync(lockPath).mtimeMs > staleMs; } catch { return false; }
}

export async function withReindexLock(pgraphDir, opts, fn) {
  const { timeoutMs = 5000, staleMs = 60000, pollMs = 50 } = opts ?? {};
  const lockPath = join(pgraphDir, 'reindex.lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx'); // atomic O_CREAT|O_EXCL
      writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      closeSync(fd);
      try { return { acquired: true, result: await fn() }; }
      finally { try { unlinkSync(lockPath); } catch { /* already gone */ } }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (isStale(lockPath, staleMs)) { try { unlinkSync(lockPath); } catch { /* raced */ } continue; }
      if (Date.now() >= deadline) return { acquired: false };
      await sleep(pollMs);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run plugins/p-graph/tools/__tests__/reindex-lock.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-graph/tools/lib/index/lock.mjs plugins/p-graph/tools/__tests__/reindex-lock.test.ts
git commit -m "feat(p-graph): add exclusive reindex lock with pid-liveness stale detection"
```

---

## Task 3: Read-only store open fallback

**Files:**
- Modify: `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs` (read-only branch in `openStore`)
- Modify: `plugins/p-graph/tools/lib/destination.mjs` (thread `{ readOnly }`)
- Test: `plugins/p-graph/tools/__tests__/store-readonly.test.ts` (new, self-contained — avoids clashing with the existing `store-read.test.ts` imports)

**Interfaces:**
- Produces: `openStore(dbPath: string, opts?: { readOnly?: boolean })` — when `readOnly` is true, opens the existing DB without any writes (no WAL pragma, no DDL, no FTS create, no meta init) and exposes the read helpers (`search`, `node`, `callers`, `callees`, `files`, `impact`, `trace`, `status`, `getMeta`, `fileHash`, `schemaStale`). Mutators (`clear`, `upsertFile`, `removeFile`, `replaceFileSymbols`, `resolvePending`, `setMeta`, `markSchemaCurrent`) throw `Error('p-graph: store is read-only')`.
- Produces: `resolveDestination(cfg, dbPath, opts?: { readOnly?: boolean })` — passes `opts` through to `openStore` for the `local` destination.

- [ ] **Step 1: Write the failing test**

Create a new self-contained file `plugins/p-graph/tools/__tests__/store-readonly.test.ts` (a separate file avoids duplicate-import clashes with the existing `store-read.test.ts`):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

describe('read-only store open', () => {
  let dir, dbPath;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pg-'));
    dbPath = join(dir, 'graph.db');
    writeFileSync(join(dir, 'a.ts'), 'function foo() { bar(); }\nfunction bar() {}');
    const w = openStore(dbPath);
    await indexFull({ root: dir, store: w, ignorePatterns: [] });
    w.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('serves queries and rejects writes', () => {
    const ro = openStore(dbPath, { readOnly: true });
    expect(ro.node('foo')).toBeTruthy();
    expect(ro.callers('bar').some((r) => r.name === 'foo')).toBe(true);
    expect(() => ro.setMeta('x', 'y')).toThrow(/read-only/);
    ro.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-graph/tools/__tests__/store-readonly.test.ts`
Expected: FAIL — `openStore` ignores the option; `setMeta` does not throw (and/or the open path runs DDL).

- [ ] **Step 3: Add the read-only branch to `openStore`**

In `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs`, change the `openStore` signature and short-circuit read-only opens before any write happens. Replace the opening of `openStore` (lines ~35-47, up to and including the FTS `try/catch`) with:

```js
export function openStore(dbPath, opts = {}) {
  const DatabaseSync = loadDatabaseSync();
  if (opts.readOnly) return openReadOnly(DatabaseSync, dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
  db.exec(DDL);

  let hasFts = false;
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      id UNINDEXED, name, qname, signature)`);
    hasFts = true;
  } catch { hasFts = false; }
```

Then, at the very end of the file (after `openStore` closes, following the final `return store;` and its `}`), add the read-only implementation. It reuses the same read SQL as the read-write store; mutators throw:

```js
// Open an already-initialized DB for reads only — no WAL pragma, no DDL, no FTS
// creation, no meta writes (all of which would fail on a read-only handle).
// Used as a fallback when the normal (writable, WAL) open fails, e.g. on a
// read-only filesystem, so a query can still answer (and the refresh degrades).
function openReadOnly(DatabaseSync, dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let hasFts = false;
  try { db.prepare('SELECT 1 FROM nodes_fts LIMIT 1').get(); hasFts = true; } catch { hasFts = false; }

  const readOnlyError = () => { throw new Error('p-graph: store is read-only'); };
  const store = {
    db, hasFts,
    getMeta: (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null,
    fileHash: (path) => db.prepare('SELECT hash FROM files WHERE path = ?').get(path)?.hash ?? null,
    close: () => db.close(),
    setMeta: readOnlyError, clear: readOnlyError, upsertFile: readOnlyError,
    removeFile: readOnlyError, replaceFileSymbols: readOnlyError,
    resolvePending: readOnlyError, markSchemaCurrent: readOnlyError,
  };
  attachReadHelpers(store, db, hasFts);
  return store;
}
```

- [ ] **Step 4: Extract the read helpers so both paths share them**

Still in `plugins/p-graph/tools/lib/destinations/local-sqlite.mjs`: the read helpers (`store.search`, `store.node`, `store.callers`, `store.callees`, `store.files`, `store.status`, `store.impact`, `store.trace`, `store.schemaStale`) are currently defined inline in `openStore` (lines ~116-231). Move their bodies into a shared function `attachReadHelpers(store, db, hasFts)` defined at module scope, and call it from the read-write `openStore` where those helpers were.

Define at module scope (near the bottom, before `openReadOnly`):

```js
// Read/query helpers shared by the read-write and read-only stores.
function attachReadHelpers(store, db, hasFts) {
  store.search = (query, { kind, lang } = {}) => {
    const q = String(query);
    let rows = [];
    if (hasFts) {
      const expr = q.trim().split(/\s+/).filter(Boolean)
        .map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
      if (expr) {
        rows = db.prepare(`SELECT n.* FROM nodes_fts f JOIN nodes n ON n.id = f.id
                           WHERE nodes_fts MATCH ?`).all(expr);
      }
    }
    if (!hasFts || rows.length === 0) {
      const like = `%${q}%`;
      rows = db.prepare(`SELECT * FROM nodes WHERE name LIKE ? OR qname LIKE ?`).all(like, like);
    }
    return rows.filter((r) => (!kind || r.kind === kind) && (!lang || r.lang === lang)).slice(0, 100);
  };
  store.node = (idOrQname) =>
    db.prepare('SELECT * FROM nodes WHERE id = ? OR qname = ? LIMIT 1').get(idOrQname, idOrQname) ?? null;
  store.callers = (name) => db.prepare(`
    SELECT DISTINCT s.* FROM edges e JOIN nodes s ON s.id = e.src_id
    JOIN nodes d ON d.id = e.dst_id WHERE d.name = ? OR d.qname = ?`).all(name, name);
  store.callees = (name) => db.prepare(`
    SELECT DISTINCT d.* FROM edges e JOIN nodes s ON s.id = e.src_id
    JOIN nodes d ON d.id = e.dst_id WHERE s.name = ? OR s.qname = ?`).all(name, name);
  store.files = (prefix) => {
    let p = prefix == null ? '' : String(prefix);
    if (p === '.' || p === './') p = '';
    else if (p.startsWith('./')) p = p.slice(2);
    return db.prepare(`
      SELECT file AS path, count(*) AS symbols FROM nodes
      WHERE file = ? OR file LIKE ? GROUP BY file ORDER BY file`).all(p, `${p}%`);
  };
  store.status = () => ({
    nodes: db.prepare('SELECT count(*) c FROM nodes').get().c,
    edges: db.prepare('SELECT count(*) c FROM edges').get().c,
    files: db.prepare('SELECT count(*) c FROM files').get().c,
    indexed_sha: store.getMeta('indexed_sha'),
    schema_version: store.getMeta('schema_version'),
    fts: hasFts,
  });
  const MAX_DEPTH = 50;
  store.impact = (name) => {
    const target = store.node(name);
    if (!target) return [];
    return db.prepare(`
      WITH RECURSIVE up(id, depth) AS (
        SELECT ?, 0
        UNION
        SELECT e.src_id, up.depth + 1 FROM edges e
        JOIN up ON e.dst_id = up.id
        WHERE up.depth < ${MAX_DEPTH} AND e.src_id IS NOT NULL
      )
      SELECT DISTINCT n.* FROM nodes n JOIN up ON n.id = up.id WHERE n.id != ?`).all(target.id, target.id);
  };
  store.trace = (fromName, toName) => {
    const from = store.node(fromName), to = store.node(toName);
    if (!from || !to) return null;
    const edges = db.prepare('SELECT src_id, dst_id FROM edges WHERE dst_id IS NOT NULL').all();
    const next = new Map();
    for (const e of edges) {
      if (!next.has(e.src_id)) next.set(e.src_id, []);
      next.get(e.src_id).push(e.dst_id);
    }
    const q = [[from.id]], seen = new Set([from.id]);
    while (q.length) {
      const path = q.shift();
      const last = path[path.length - 1];
      if (last === to.id) return path.map((id) => store.node(id).qname);
      for (const nx of next.get(last) ?? []) {
        if (!seen.has(nx)) { seen.add(nx); q.push([...path, nx]); }
      }
    }
    return null;
  };
  store.schemaStale = () => Number(store.getMeta('schema_version')) !== SCHEMA_VERSION;
}
```

In the read-write `openStore`, **delete** the inline definitions of those same helpers (the `store.search = ...` through `store.trace = ...` and `store.schemaStale = ...` blocks) and replace them with a single call, placed where `store.search` used to start:

```js
  attachReadHelpers(store, db, hasFts);
```

Keep `store.markSchemaCurrent`, the meta-init block, and `return store;` as they are. (`store.fileHash` from Task 1 stays inline in the read-write path.)

- [ ] **Step 5: Thread `{ readOnly }` through `resolveDestination`**

In `plugins/p-graph/tools/lib/destination.mjs`, replace the file with:

```js
import { openStore } from './destinations/local-sqlite.mjs';

export function resolveDestination(cfg, dbPath, opts = {}) {
  const kind = cfg?.destination ?? 'local';
  if (kind === 'local') return openStore(dbPath, opts);
  throw new Error(`unknown destination: ${kind}`);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run plugins/p-graph/tools/__tests__/store-readonly.test.ts`
Expected: PASS (the new read-only case).

- [ ] **Step 7: Run the full store + query suite for regressions**

Run: `npx vitest run plugins/p-graph/tools/__tests__/store-open.test.ts plugins/p-graph/tools/__tests__/store-write.test.ts plugins/p-graph/tools/__tests__/store-traverse.test.ts plugins/p-graph/tools/__tests__/cli-query-basic.test.ts plugins/p-graph/tools/__tests__/cli-query-graph.test.ts`
Expected: PASS (the helper extraction is behaviour-preserving).

- [ ] **Step 8: Commit**

```bash
git add plugins/p-graph/tools/lib/destinations/local-sqlite.mjs plugins/p-graph/tools/lib/destination.mjs plugins/p-graph/tools/__tests__/store-readonly.test.ts
git commit -m "feat(p-graph): add read-only store open fallback; share read helpers"
```

---

## Task 4: Freshness gate module

**Files:**
- Create: `plugins/p-graph/tools/lib/freshness.mjs`
- Test: covered by the CLI acceptance tests in Task 5 (the gate is exercised end-to-end there). This task also adds a small unit test for the pure helpers.
- Test: `plugins/p-graph/tools/__tests__/freshness.test.ts`

**Interfaces:**
- Consumes (Task 1): `gitChangedFiles`, `indexChanged`, `headSha` from `build.mjs`.
- Consumes (Task 2): `withReindexLock` from `lock.mjs`.
- Consumes: `isIgnored` from `config.mjs`, `resolveLang` from `parse/index.mjs`.
- Produces: `computeActionable(change, ignorePatterns): { modified: string[], deleted: string[] }`.
- Produces: `driftCount(actionable): number`.
- Produces: `ensureFresh(ctx): Promise<void>` where `ctx = { command, opts, root, store, ignorePatterns, pgraphDir, warn }`. No-op for non-query commands. Never throws. Writes banners/notes via `ctx.warn`.

- [ ] **Step 1: Write the failing test (pure helpers)**

Create `plugins/p-graph/tools/__tests__/freshness.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeActionable, driftCount } from '../lib/freshness.mjs';

describe('computeActionable', () => {
  it('keeps only source files pgraph indexes, drops ignored / non-source', () => {
    const change = {
      modified: ['src/a.ts', 'README.md', 'node_modules/x/i.js', 'data.json'],
      deleted: ['src/b.ts', 'docs/notes.md'],
    };
    const act = computeActionable(change, []);
    expect(act.modified).toEqual(['src/a.ts']);       // README.md, data.json (non-source), node_modules (ignored) dropped
    expect(act.deleted).toEqual(['src/b.ts', 'docs/notes.md']); // deletions keep non-source (removeFile is a harmless no-op) but drop ignored
    expect(driftCount(act)).toBe(3);
  });

  it('drift is 0 when only non-source files changed', () => {
    const act = computeActionable({ modified: ['README.md'], deleted: [] }, []);
    expect(driftCount(act)).toBe(0);
  });
});
```

Note on `deleted`: the filter only removes ignored paths, not non-source ones — `store.removeFile` on a path never in the graph is a harmless no-op, and a deleted `.md` never had symbols anyway. Deletions still count toward drift so a removed file triggers a refresh that prunes any edges into it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-graph/tools/__tests__/freshness.test.ts`
Expected: FAIL — module `freshness.mjs` does not exist.

- [ ] **Step 3: Create the freshness module**

Create `plugins/p-graph/tools/lib/freshness.mjs`:

```js
import { gitChangedFiles, indexChanged, headSha } from './index/build.mjs';
import { withReindexLock } from './index/lock.mjs';
import { isIgnored } from './config.mjs';
import { resolveLang } from './parse/index.mjs';

const QUERY_COMMANDS = new Set([
  'search', 'node', 'callers', 'callees', 'impact', 'trace', 'context', 'explore', 'files',
]);

const staleBanner = (n) =>
  `⚠ p-graph STALE: ${n} files changed since index; results may be wrong. Run /p-graph:sync`;
const UNKNOWN_BANNER =
  `⚠ p-graph STALE: cannot verify freshness (not a git checkout); results may be wrong. Run /p-graph:sync`;

// Only files the graph actually indexes count as drift. git reports every changed
// path, but indexChanged skips ignored and non-source files — counting the raw
// git output would make an uncommitted README.md edit look like perpetual drift.
export function computeActionable(change, ignorePatterns) {
  return {
    modified: change.modified.filter((rel) => !isIgnored(rel, ignorePatterns) && resolveLang(rel)),
    deleted: change.deleted.filter((rel) => !isIgnored(rel, ignorePatterns)),
  };
}
export const driftCount = (a) => a.modified.length + a.deleted.length;

function autorefreshEnabled(opts) {
  return process.env.PGRAPH_AUTOREFRESH !== '0' && !opts['stale-ok'];
}

// Runs under the reindex lock. Re-checks drift (another process may have just
// refreshed), then reparses the actionable set in place. Returns { refreshed }.
async function doReindex(ctx) {
  const { root, store, ignorePatterns, warn } = ctx;
  const change = gitChangedFiles(root, store.getMeta('indexed_sha'));
  const actionable = change ? computeActionable(change, ignorePatterns) : { modified: [], deleted: [] };
  if (driftCount(actionable) === 0) return { refreshed: true }; // someone else refreshed while we waited

  warn(store.schemaStale?.()
    ? 'p-graph: rebuilding graph after schema upgrade…'
    : `p-graph: refreshing ${driftCount(actionable)} changed files…`);

  let failed = 0;
  await indexChanged({
    root, store, ignorePatterns,
    changedFiles: () => actionable,
    onError: () => { failed++; },
  });
  if (failed > 0) return { refreshed: false }; // partial — keep flagging drift
  const sha = headSha(root);
  if (sha) store.setMeta('indexed_sha', sha);
  return { refreshed: true };
}

// Called before every query command. Refreshes the graph if it has drifted and
// auto-refresh is enabled; otherwise (or on any failure) answers from the current
// graph and prints a staleness banner. Never throws — a query must always answer.
export async function ensureFresh(ctx) {
  const { command, opts, root, store, ignorePatterns, pgraphDir, warn } = ctx;
  if (!QUERY_COMMANDS.has(command)) return;

  let change;
  try { change = gitChangedFiles(root, store.getMeta('indexed_sha')); }
  catch { change = null; }
  if (change === null) { warn(UNKNOWN_BANNER); return; } // not a git checkout

  const drift = driftCount(computeActionable(change, ignorePatterns));
  if (drift === 0) return; // fresh — fast path

  if (!autorefreshEnabled(opts)) { warn(staleBanner(drift)); return; } // opt-out

  try {
    const { acquired, result } = await withReindexLock(pgraphDir, {}, () => doReindex(ctx));
    if (acquired && result?.refreshed) return; // fresh graph, no banner
  } catch { /* fall through to banner */ }
  warn(staleBanner(drift)); // timed out, partial, or errored
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run plugins/p-graph/tools/__tests__/freshness.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/p-graph/tools/lib/freshness.mjs plugins/p-graph/tools/__tests__/freshness.test.ts
git commit -m "feat(p-graph): add freshness gate (actionable drift + guarded auto-refresh)"
```

---

## Task 5: Wire the gate into the CLI + acceptance tests

**Files:**
- Modify: `plugins/p-graph/tools/lib/cli/commands.mjs` (call `ensureFresh`; import `headSha`)
- Modify: `plugins/p-graph/tools/pgraph.mjs` (ctx `warn` + `pgraphDir`; read-only open fallback)
- Test: `plugins/p-graph/tools/__tests__/cli-autorefresh.test.ts`
- Test: `plugins/p-graph/tools/__tests__/cli-concurrency.test.ts`

**Interfaces:**
- Consumes (Task 4): `ensureFresh(ctx)`.
- Consumes (Task 1): `headSha(root)`.
- Consumes (Task 3): `resolveDestination(cfg, dbPath, { readOnly })`.
- ctx passed to `runCommand` gains: `pgraphDir: string`, `warn: (msg: string) => void`.

- [ ] **Step 1: Write the failing acceptance test**

Create `plugins/p-graph/tools/__tests__/cli-autorefresh.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-graph/tools/pgraph.mjs');

let dir;
const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
const run = (args, env) =>
  spawnSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8', env: { ...process.env, ...env } });

function initRepo() {
  dir = mkdtempSync(join(tmpdir(), 'pg-'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  mkdirSync(join(dir, '.pgraph'));
  writeFileSync(join(dir, 'a.ts'), 'export function foo() { bar(); }\nexport function bar() {}');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
}
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('cli auto-refresh', () => {
  it('reflects an uncommitted change without a manual sync', () => {
    initRepo();
    run(['index', '--full']);
    // baseline: only foo calls bar
    expect(JSON.parse(run(['callers', 'bar', '--json']).stdout).map((r) => r.name)).toEqual(['foo']);

    // add a second caller, do NOT sync
    writeFileSync(join(dir, 'a.ts'),
      'export function foo() { bar(); }\nexport function bar() {}\nexport function baz() { bar(); }');
    const r = run(['callers', 'bar', '--json']);
    const names = JSON.parse(r.stdout).map((x) => x.name).sort();
    expect(names).toEqual(['baz', 'foo']);           // auto-refreshed
    expect(r.stderr).toContain('p-graph: refreshing');
  }, 30000);

  it('drift 0 is the fast path — no refresh note', () => {
    initRepo();
    run(['index', '--full']);
    const r = run(['callers', 'bar', '--json']);
    expect(r.stderr).not.toContain('refreshing');
    expect(JSON.parse(r.stdout).map((x) => x.name)).toEqual(['foo']);
  }, 30000);

  it('a non-source edit does not trigger a refresh', () => {
    initRepo();
    run(['index', '--full']);
    writeFileSync(join(dir, 'README.md'), '# hello');
    const r = run(['callers', 'bar', '--json']);
    expect(r.stderr).not.toContain('refreshing');
    expect(r.stderr).not.toContain('STALE');
  }, 30000);

  it('--stale-ok skips refresh and prints the banner when drifted', () => {
    initRepo();
    run(['index', '--full']);
    writeFileSync(join(dir, 'a.ts'),
      'export function foo() { bar(); }\nexport function bar() {}\nexport function baz() { bar(); }');
    const r = run(['callers', 'bar', '--json', '--stale-ok']);
    expect(JSON.parse(r.stdout).map((x) => x.name)).toEqual(['foo']); // NOT refreshed
    expect(r.stderr).toContain('⚠ p-graph STALE: 1 files changed since index');
  }, 30000);

  it('PGRAPH_AUTOREFRESH=0 skips refresh and prints the banner', () => {
    initRepo();
    run(['index', '--full']);
    writeFileSync(join(dir, 'a.ts'),
      'export function foo() { bar(); }\nexport function bar() {}\nexport function baz() { bar(); }');
    const r = run(['callers', 'bar', '--json'], { PGRAPH_AUTOREFRESH: '0' });
    expect(JSON.parse(r.stdout).map((x) => x.name)).toEqual(['foo']);
    expect(r.stderr).toContain('⚠ p-graph STALE:');
  }, 30000);

  it('non-git repo: query still answers, with the unknown-drift banner', () => {
    dir = mkdtempSync(join(tmpdir(), 'pg-'));
    mkdirSync(join(dir, '.git'));    // empty dir: findRepoRoot stops here, git commands fail
    mkdirSync(join(dir, '.pgraph'));
    writeFileSync(join(dir, 'a.ts'), 'export function foo() { bar(); }\nexport function bar() {}');
    run(['index', '--full']);
    const r = run(['callers', 'bar', '--json']);
    expect(JSON.parse(r.stdout).map((x) => x.name)).toEqual(['foo']); // still answers
    expect(r.stderr).toContain('cannot verify freshness');
  }, 30000);

  it('status does not reindex', () => {
    initRepo();
    run(['index', '--full']);
    const before = JSON.parse(run(['status', '--json']).stdout);
    const r = run(['status', '--json']);
    const after = JSON.parse(r.stdout);
    expect(after.nodes).toBe(before.nodes);
    expect(after.indexed_sha).toBe(before.indexed_sha);
    expect(r.stderr).not.toContain('refreshing');
  }, 30000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run plugins/p-graph/tools/__tests__/cli-autorefresh.test.ts`
Expected: FAIL — queries do not auto-refresh yet (e.g. `callers bar` returns only `foo` after the edit; no `refreshing` note; no banner).

- [ ] **Step 3: Call the gate from `runCommand`**

In `plugins/p-graph/tools/lib/cli/commands.mjs`:

Replace the top of the file (lines 1-7, the imports and the local `headSha`) with:

```js
import { indexFull, indexChanged, gitChangedFiles, headSha } from '../index/build.mjs';
import { ensureFresh } from '../freshness.mjs';
```

Then change the start of `runCommand` so the gate runs first:

```js
export async function runCommand(ctx) {
  await ensureFresh(ctx); // no-op for non-query commands; refreshes a stale graph before a query
  const { command, opts, root, store, ignorePatterns, out, emitJson, die } = ctx;
```

(The rest of `runCommand` is unchanged. `headSha` is now the imported one.)

- [ ] **Step 4: Add `warn`, `pgraphDir`, and the read-only fallback to `pgraph.mjs`**

In `plugins/p-graph/tools/pgraph.mjs`:

Add a `warn` helper next to `out`/`emitJson` (after line 27):

```js
function warn(s) { process.stderr.write(s + '\n'); }
```

Replace the store-open block (lines ~49-51) with a read-only fallback:

```js
let store;
try {
  store = resolveDestination(cfg, dbPath);
} catch (e) {
  // Writable (WAL) open failed — e.g. a read-only filesystem. Fall back to a
  // read-only store so the query can still answer (the refresh will then degrade
  // with a banner). If even this fails, there is genuinely no graph to read.
  try { store = resolveDestination(cfg, dbPath, { readOnly: true }); }
  catch { die(e.message, 1); }
}
```

Replace the `runCommand` call (lines ~53-54) to pass `warn` and `pgraphDir`:

```js
try {
  await runCommand({
    command, opts, root, store,
    ignorePatterns: readIgnorePatterns(root),
    pgraphDir: join(root, PGRAPH_DIR),
    out, emitJson, warn, die,
  });
} catch (e) {
```

(`join` and `PGRAPH_DIR` are already imported at the top of the file.)

- [ ] **Step 5: Run the acceptance test to verify it passes**

Run: `npx vitest run plugins/p-graph/tools/__tests__/cli-autorefresh.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Write the concurrency test**

Create `plugins/p-graph/tools/__tests__/cli-concurrency.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-graph/tools/pgraph.mjs');
let dir;
const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
const runAsync = (args) => new Promise((resolve) => {
  const p = spawn('node', [CLI, ...args], { cwd: dir });
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => resolve({ code, out, err }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('cli concurrency', () => {
  it('two parallel queries after a committed change do not corrupt the graph', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pg-'));
    git(['init', '-q']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    mkdirSync(join(dir, '.pgraph'));
    writeFileSync(join(dir, 'a.ts'), 'export function foo() { bar(); }\nexport function bar() {}');
    git(['add', '.']); git(['commit', '-qm', 'init']);
    execFileSync('node', [CLI, 'index', '--full'], { cwd: dir });

    // Commit a second caller so both processes see committed drift.
    writeFileSync(join(dir, 'a.ts'),
      'export function foo() { bar(); }\nexport function bar() {}\nexport function baz() { bar(); }');
    git(['add', '.']); git(['commit', '-qm', 'add baz']);

    const [r1, r2] = await Promise.all([
      runAsync(['callers', 'bar', '--json']),
      runAsync(['callers', 'bar', '--json']),
    ]);
    for (const r of [r1, r2]) {
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out).map((x) => x.name).sort()).toEqual(['baz', 'foo']);
    }

    // Graph is intact and readable afterwards.
    const st = JSON.parse(execFileSync('node', [CLI, 'status', '--json'], { cwd: dir, encoding: 'utf-8' }));
    expect(st.nodes).toBeGreaterThanOrEqual(3);
  }, 45000);
});
```

- [ ] **Step 7: Run the concurrency test to verify it passes**

Run: `npx vitest run plugins/p-graph/tools/__tests__/cli-concurrency.test.ts`
Expected: PASS. Both processes return `[baz, foo]`; `graph.db` remains readable.

- [ ] **Step 8: Run the full p-graph suite for regressions**

Run: `npx vitest run plugins/p-graph`
Expected: PASS (all existing + new tests).

- [ ] **Step 9: Commit**

```bash
git add plugins/p-graph/tools/lib/cli/commands.mjs plugins/p-graph/tools/pgraph.mjs plugins/p-graph/tools/__tests__/cli-autorefresh.test.ts plugins/p-graph/tools/__tests__/cli-concurrency.test.ts
git commit -m "feat(p-graph): auto-refresh the graph before answering structural queries"
```

---

## Task 6: Docs, rule/template updates, version bump

**Files:**
- Modify: `plugins/p-graph/skills/_shared/templates/p-graph-rule.template.md`
- Modify: `plugins/p-graph/skills/_shared/templates/pgraph-claude-md.template.md`
- Modify: `plugins/p-graph/README.md`
- Modify: `plugins/p-graph/skills/sync/SKILL.md`
- Modify: `plugins/p-graph/.claude-plugin/plugin.json`

**Interfaces:** none (documentation + metadata).

Before editing the skill/template files, read the `superpowers:writing-skills` skill (per repo convention for touching skills), and keep all artifact text in English.

- [ ] **Step 1: Update the installed rule template**

Replace the **Freshness** paragraph at the bottom of `plugins/p-graph/skills/_shared/templates/p-graph-rule.template.md` (lines ~19-21) with:

```markdown
**Freshness:** structural queries **auto-refresh** the graph before answering —
`pgraph` reindexes any changed files first, so a query never answers from a stale
graph and manual syncing is normally unnecessary. To skip the refresh (answer from
the graph as-is), pass `--stale-ok` or set `PGRAPH_AUTOREFRESH=0`; when the graph
is stale you'll get a one-line `⚠ p-graph STALE` note on stderr. `/p-graph:sync`
is still available for an explicit full rebuild (`index --full`) and to warm the
graph after a pull.
```

- [ ] **Step 2: Update the CLAUDE.md command template**

In `plugins/p-graph/skills/_shared/templates/pgraph-claude-md.template.md`, replace the final line `Refresh with `/p-graph:sync`.` with:

```markdown
Structural queries auto-refresh the graph before answering (pass `--stale-ok` or set
`PGRAPH_AUTOREFRESH=0` to skip). `/p-graph:sync` forces an explicit full rebuild.
```

- [ ] **Step 3: Update the README**

In `plugins/p-graph/README.md`:

Replace the sentence after the commands table (line ~78, `Refresh with `/p-graph:sync`. Prefer these commands over grep...`) with:

```markdown
Structural queries **auto-refresh** the graph before answering: `pgraph` reindexes
changed files first (incrementally, git-based), so day-to-day freshness is
automatic and you rarely need `/p-graph:sync`. Pass `--stale-ok` or set
`PGRAPH_AUTOREFRESH=0` on any query to skip the refresh and answer from the graph
as-is (you'll get a `⚠ p-graph STALE` note on stderr when it's stale). Prefer these
commands over grep for structural questions — a grep can find a symbol name in a
string literal; the graph tells you what actually calls it at runtime.
```

In the Skills table (line ~53), change the `/p-graph:sync` row to:

```markdown
| `/p-graph:sync` | Explicitly rebuild the graph — full (`--full`) or incremental (`--changed`). Day-to-day freshness is automatic (queries auto-refresh); use this for a full rebuild after a big refactor or to warm the graph after a pull. |
```

- [ ] **Step 4: Update the sync skill description and body**

In `plugins/p-graph/skills/sync/SKILL.md`:

Change the frontmatter `description` to:

```yaml
description: Explicitly rebuild the p-graph code graph — full or incremental. Day-to-day freshness is automatic (queries auto-refresh); use this for a full rebuild after a big refactor, or to warm the graph after a pull. Use when the user says "sync p-graph", "reindex", "rebuild the code graph", or "full reindex".
```

Add this sentence at the top of the body, right after the `# p-graph: sync` heading:

```markdown
> Structural queries now auto-refresh the graph before answering, so you rarely
> need this. Use `/p-graph:sync` for an explicit full rebuild after a large
> refactor, or to warm the graph after a pull/branch-switch.
```

- [ ] **Step 5: Bump the plugin version**

In `plugins/p-graph/.claude-plugin/plugin.json`, change `"version": "0.3.1"` to `"version": "0.4.0"`.

- [ ] **Step 6: Validate the plugin metadata**

Run: `npm run validate`
Expected: PASS (no schema errors for p-graph).

- [ ] **Step 7: Run the whole test suite**

Run: `npm test`
Expected: PASS (entire monorepo suite).

- [ ] **Step 8: Commit**

```bash
git add plugins/p-graph/skills plugins/p-graph/README.md plugins/p-graph/.claude-plugin/plugin.json
git commit -m "docs(p-graph): document auto-refresh; reframe sync as explicit rebuild; bump 0.4.0"
```

---

## Self-review notes (for the implementer)

- **Do not tag or publish.** The maintainer cuts the release. This plan ends at committed code + a version bump.
- **stdout must stay clean.** Every note/banner uses `ctx.warn` → stderr. If you ever see a banner land in `stdout` in a test, it's a wiring bug in `pgraph.mjs`.
- **Windows:** all file ops use `node:fs`; the lock never renames over an open file; git is invoked via `execFileSync('git', …)`. No shell-specific syntax is shipped.
- **If a step's test unexpectedly passes before you implement it**, stop and investigate — the test may be wrong.
