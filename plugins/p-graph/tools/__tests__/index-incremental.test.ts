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
