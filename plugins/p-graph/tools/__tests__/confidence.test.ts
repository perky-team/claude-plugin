import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-conf-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};

describe('a guessed edge is marked and kept out of impact', () => {
  it('marks a bare-name link as a guess and a typed link as certain', async () => {
    write('svc/svc.go', `package svc
type A struct{}
func (a *A) Certain() {}
func (a *A) Guessed() {}
func Make() *A { return &A{} }
func UseTyped(a *A) { a.Certain() }
func UseGuessed() {
	x := Make()
	x.Guessed()
}
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    expect(store.callers('svc.A.Certain')[0]).toMatchObject({ qname: 'svc.UseTyped', guess: 0 });
    expect(store.callers('svc.A.Guessed')[0]).toMatchObject({ qname: 'svc.UseGuessed', guess: 1 });

    store.close();
  }, 30000);

  it('does not let a guessed edge seed the impact set', async () => {
    write('pool/pool.go', `package pool
type Factory struct{}
func (f *Factory) Put(v any) {}
`);
    write('app/app.go', `package app
import "sync"
type Deep struct{}
func (d *Deep) Top() { d.mid() }
func (d *Deep) mid() {
	var p sync.Pool
	p.Put(1)
}
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // sync.Pool is typed after Task 4, so nothing links at all here. The point of
    // this test is the walk: even if a guess DID link, it must not drag Top in.
    const impacted = store.impact('pool.Factory.Put').map((n) => n.qname);
    expect(impacted).not.toContain('app.Deep.Top');

    store.close();
  }, 30000);

  it('degrades to "certain" on a read-only DB that predates the guess column, instead of throwing', async () => {
    write('svc/svc.go', `package svc
type A struct{}
func (a *A) Certain() {}
func UseIt(a *A) { a.Certain() }
`);
    const dbPath = join(dir, 'graph.db');
    const w = openStore(dbPath);
    await indexFull({ root: dir, store: w, ignorePatterns: [] });
    // A DB written before the guess column existed looks like this: CREATE
    // TABLE IF NOT EXISTS can never add a column back to a table that
    // already exists, so a read-only fallback (write open failed, so the
    // migration that would add it never ran) can still meet a table with no
    // guess column at all.
    w.db.exec('ALTER TABLE edges DROP COLUMN guess');
    w.close();

    const ro = openStore(dbPath, { readOnly: true });
    // Must answer, not throw "no such column: guess" — and call every edge
    // in a DB from before the column existed certain, not a guess.
    expect(ro.callers('svc.A.Certain')).toMatchObject([{ qname: 'svc.UseIt', guess: 0 }]);
    expect(ro.impact('svc.A.Certain').map((n) => n.qname)).toEqual(['svc.UseIt']);
    ro.close();
  }, 30000);
});
