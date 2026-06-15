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
