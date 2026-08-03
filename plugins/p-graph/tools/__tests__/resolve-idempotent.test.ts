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
func New() *A { return &A{} }
func (a *A) Frobnicate() {}
`);
    // `a` takes its type from a function's return value, which the graph does not
    // read, so this call can only ever resolve by its unique bare name. That is
    // the resolution an added namesake has to invalidate.
    write('caller/c.go', `package caller
import "x/pkga"
func Do() { a := pkga.New(); a.Frobnicate() }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });
    expect(store.callers('pkga.A.Frobnicate').map((n) => n.qname)).toEqual(['caller.Do']);

    // A second Frobnicate appears. The bare name is no longer unique, so the graph
    // cannot tell which one caller.Do calls — the edge must go, not linger.
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
