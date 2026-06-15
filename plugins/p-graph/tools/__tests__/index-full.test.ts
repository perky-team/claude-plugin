import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('full index', () => {
  it('indexes supported files and skips ignored dirs', async () => {
    writeFileSync(join(dir, 'a.ts'), 'function foo() { bar(); }\nfunction bar() {}');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'skip.ts'), 'function nope() {}');
    const store = openStore(':memory:');
    const res = await indexFull({ root: dir, store, ignorePatterns: [] });
    expect(res.files).toBe(1);
    expect(store.node('foo')).toBeTruthy();
    expect(store.node('nope')).toBeNull();
    expect(store.callees('foo').map((x) => x.name)).toContain('bar');
    store.close();
  }, 30000);
});
