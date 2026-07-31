import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-perf-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};

describe('the impact frontier scan does not repeat per reached node', () => {
  it('queries once per distinct name, not once per reached symbol', async () => {
    // A chain of 30 callers, so the impact set is large but the number of
    // distinct names to look up stays small.
    let src = 'package chain\nfunc Leaf() {}\n';
    for (let i = 0; i < 30; i++) {
      src += `func Step${i}() { ${i === 0 ? 'Leaf' : `Step${i - 1}`}() }\n`;
    }
    write('chain/chain.go', src);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });
    expect(store.impact('chain.Leaf')).toHaveLength(30);

    // Count the gap-row lookups by wrapping the prepared-statement factory.
    let queries = 0;
    const realPrepare = store.db.prepare.bind(store.db);
    store.db.prepare = (sql) => {
      const stmt = realPrepare(sql);
      if (!/FROM edges/.test(sql)) return stmt;
      const realAll = stmt.all.bind(stmt);
      stmt.all = (...a) => { queries++; return realAll(...a); };
      return stmt;
    };
    store.gapsAround('chain.Leaf');
    // 31 reached symbols would mean ~62 lookups under the old code. One lookup
    // per distinct name is the target; allow a small constant for the no-caller
    // scan.
    expect(queries).toBeLessThan(10);

    store.close();
  }, 30000);
});
