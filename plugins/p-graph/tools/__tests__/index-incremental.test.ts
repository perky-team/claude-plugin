import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull, indexChanged } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('incremental index', () => {
  it('reindexes only changed files and removes deleted ones', async () => {
    writeFileSync(join(dir, 'a.ts'), 'function foo() {}');
    writeFileSync(join(dir, 'b.ts'), 'function bar() {}');
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });
    expect(store.node('bar')).toBeTruthy();

    writeFileSync(join(dir, 'a.ts'), 'function foo() {}\nfunction baz() {}');
    rmSync(join(dir, 'b.ts'));
    await indexChanged({
      root: dir, store, ignorePatterns: [],
      changedFiles: () => ({ modified: ['a.ts'], deleted: ['b.ts'] }),
    });
    expect(store.node('baz')).toBeTruthy();
    expect(store.node('bar')).toBeNull();
    store.close();
  }, 30000);

  it('bootstraps a full index when there is no prior indexed_sha', async () => {
    // A clean, fully-committed repo has no working-tree changes, so a git-only
    // change provider returns nothing. Without the bootstrap, `index --changed`
    // (the default) would build an empty graph and still record indexed_sha.
    writeFileSync(join(dir, 'a.ts'), 'function foo() {}\nfunction bar() {}');
    const store = openStore(':memory:');
    expect(store.getMeta('indexed_sha')).toBeNull();
    const res = await indexChanged({
      root: dir, store, ignorePatterns: [],
      changedFiles: undefined, // force the git-provider path, but no baseline exists
    });
    expect(res.files).toBe(1); // fell back to a full index, not 0 changed
    expect(store.node('foo')).toBeTruthy();
    expect(store.node('bar')).toBeTruthy();
    store.close();
  }, 30000);

  it('forces a full reindex when the stored schema version is stale', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function alpha() {}');
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });
    expect(store.schemaStale()).toBe(false);

    // Simulate a DB written by an older version: stale schema + a symbol whose
    // file no longer exists on disk. An incremental run would leave the ghost;
    // a forced full reindex must drop it.
    store.replaceFileSymbols('ghost.ts', [
      { id: 'ghost', name: 'ghost', qname: 'ghost', kind: 'function', lang: 'ts', file: 'ghost.ts', start_line: 1, end_line: 1, signature: '', doc: '', container_id: null },
    ], []);
    store.setMeta('schema_version', 1);
    store.setMeta('indexed_sha', 'deadbeef');
    expect(store.schemaStale()).toBe(true);

    await indexChanged({
      root: dir, store, ignorePatterns: [],
      changedFiles: () => ({ modified: [], deleted: [] }), // no changes -> only a full rebuild clears the ghost
    });
    expect(store.node('ghost')).toBeNull();
    expect(store.node('alpha')).toBeTruthy();
    expect(store.schemaStale()).toBe(false);
    store.close();
  }, 30000);

  it('reconnects a call edge when its target symbol moves to another file', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function f() { g(); }');
    writeFileSync(join(dir, 'b.ts'), 'export function g() {}');
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });
    expect(store.callers('g').map((x) => x.name)).toContain('f');

    // g moves from b.ts to c.ts — a.ts (the caller) is untouched.
    rmSync(join(dir, 'b.ts'));
    writeFileSync(join(dir, 'c.ts'), '\n\nexport function g() {}');
    await indexChanged({
      root: dir, store, ignorePatterns: [],
      changedFiles: () => ({ modified: ['c.ts'], deleted: ['b.ts'] }),
    });
    // Without re-resolving dangling dst_id the edge would silently vanish.
    expect(store.callers('g').map((x) => x.name)).toContain('f');
    expect(store.trace('f', 'g')).toEqual(['f', 'g']);
    store.close();
  }, 30000);
});
