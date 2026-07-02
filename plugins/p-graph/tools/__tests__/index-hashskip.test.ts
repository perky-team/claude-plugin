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
