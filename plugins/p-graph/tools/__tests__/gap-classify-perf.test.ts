import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

function write(dir, rel, src) {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
}

// A repo with `n` caller files that all reach for the same ambiguous,
// qualified name ("helper.Frob"): "helper" is a real repo package (so the
// qualifier check has something to find), but it does not define Frob, and
// two OTHER packages do (so the bare name "Frob" is not unique and stays
// unresolved). Every caller file produces one gap row, and every one of
// those rows shares the exact same (bare name, lang) pair and the exact same
// (qualifier, lang) pair — no matter how many caller files there are.
async function buildFixture(n) {
  const dir = mkdtempSync(join(tmpdir(), 'pg-gapperf-'));
  write(dir, 'helper/helper.go', 'package helper\nfunc Noop() {}\n');
  write(dir, 'pkga/pkga.go', 'package pkga\nfunc Frob() {}\n');
  write(dir, 'pkgb/pkgb.go', 'package pkgb\nfunc Frob() {}\n');
  for (let i = 0; i < n; i++) {
    write(dir, `caller${i}/caller${i}.go`,
      `package caller${i}\nimport "x/helper"\nvar _ = helper.Frob()\n`);
  }
  const store = openStore(':memory:');
  await indexFull({ root: dir, store, ignorePatterns: [] });
  return { store, dir };
}

// Counts .all()/.get() calls on the two statement shapes that answer "how
// many repo symbols share this bare name" and "does this qualifier name a
// repo package". Before this fix, both answers were correlated subqueries on
// the gap-rows query itself, so SQLite re-asked them once per MATCHED ROW —
// invisible at this level (one row-returning statement, however slow inside).
// After the fix, both are separate, small statements asked once per distinct
// pair, so counting calls to exactly these two statement shapes is a direct,
// deterministic proxy for "did the number of rows leak into the number of
// times we asked the same question".
function countClassifyQueries(store) {
  let queries = 0;
  const realPrepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql) => {
    const stmt = realPrepare(sql);
    const isCandidateCounts = /GROUP BY name/.test(sql);
    const isQualifierExists = /WHERE lang = \?/.test(sql) && /qname LIKE \? LIMIT 1/.test(sql);
    if (!isCandidateCounts && !isQualifierExists) return stmt;
    const track = (fn) => (...a) => { queries++; return fn(...a); };
    if (stmt.all) stmt.all = track(stmt.all.bind(stmt));
    if (stmt.get) stmt.get = track(stmt.get.bind(stmt));
    return stmt;
  };
  return () => queries;
}

describe('gap classification asks each question once per distinct pair, not once per row', () => {
  it('keeps the classify-query count the same whether 5 rows or 50 rows share the pair', async () => {
    const small = await buildFixture(5);
    const readSmall = countClassifyQueries(small.store);
    const smallRows = small.store.gapsFor('Frob');
    expect(smallRows).toHaveLength(5);
    expect(smallRows.every((r) => r.reason === 'ambiguous')).toBe(true);
    const smallQueries = readSmall();

    const big = await buildFixture(50);
    const readBig = countClassifyQueries(big.store);
    const bigRows = big.store.gapsFor('Frob');
    expect(bigRows).toHaveLength(50);
    expect(bigRows.every((r) => r.reason === 'ambiguous')).toBe(true);
    const bigQueries = readBig();

    // Both fixtures share exactly one (bare, lang) pair ("Frob", "go") and one
    // (qualifier, lang) pair ("helper", "go"). A count that grows with the row
    // count (5 vs 50) means the per-row cost this fix removed is back.
    expect(smallQueries).toBeGreaterThan(0);
    expect(bigQueries).toBe(smallQueries);

    small.store.close();
    big.store.close();
    rmSync(small.dir, { recursive: true, force: true });
    rmSync(big.dir, { recursive: true, force: true });
  }, 30000);
});
