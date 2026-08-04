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

  // The rule this locks in: a caller that is certain by ANY path is certain,
  // and is reported ONCE. Two things can break it, and both used to pass the
  // suite: folding the group with MAX instead of MIN buries a certain caller
  // under the UNVERIFIED heading as soon as some other call site guessed its
  // way to the same target, and dropping the grouping altogether prints that
  // caller twice, once per guess value.
  it('reports a caller reached by both a certain and a guessed edge once, as certain', async () => {
    write('mix/mix.go', `package mix
type A struct{}
func (a *A) Ping() {}
func Make() *A { return &A{} }
func Both(a *A) {
	a.Ping()
	x := Make()
	x.Ping()
}
func OnlyGuess() {
	y := Make()
	y.Ping()
}
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // Both writes two call sites to the same target: one on a typed parameter
    // (Pass F, a recorded type -> certain) and one on a local typed from a
    // function's return value, which nothing reads (Pass B's unique bare name
    // -> a guess). OnlyGuess writes the guessed shape alone.
    const rows = store.callers('mix.A.Ping')
      .map((r) => ({ qname: r.qname, guess: r.guess }))
      .sort((a, b) => a.qname.localeCompare(b.qname));
    expect(rows).toEqual([
      { qname: 'mix.Both', guess: 0 },
      { qname: 'mix.OnlyGuess', guess: 1 },
    ]);

    // callees folds its groups with its own copy of the same expression, so it
    // is checked here too: from Both, Ping is certain and listed once.
    const callees = store.callees('mix.Both')
      .filter((r) => r.name === 'Ping')
      .map((r) => ({ qname: r.qname, guess: r.guess }));
    expect(callees).toEqual([{ qname: 'mix.A.Ping', guess: 0 }]);

    store.close();
  }, 30000);

  it('does not let a guessed edge seed or extend the impact walk, and still walks a certain chain in full', async () => {
    write('svc2/svc2.go', `package svc2
type A struct{}
func (a *A) Guessed() {}
func Make() *A { return &A{} }
func Reached() {
	x := Make()
	x.Guessed()
}
func Caller() { Reached() }

func Target() {}
func M1() { Target() }
func M2() { M1() }
func M3() { M2() }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // A local's type from a call's return value is not tracked (that is a
    // separate gap from the field/param/var typing Task 4 covers), so this
    // call links only through Pass B's unique-bare-name guess. Confirm the
    // edge is real — linked (dst_id set) AND marked a guess — before trusting
    // anything below: without a resolved edge here, the rest of this test
    // would prove nothing.
    expect(store.callers('svc2.A.Guessed')).toMatchObject([{ qname: 'svc2.Reached', guess: 1 }]);

    const guessedImpact = store.impact('svc2.A.Guessed').map((n) => n.qname);
    // 1. cannot seed: Reached only reaches the target through a guess.
    expect(guessedImpact).not.toContain('svc2.Reached');
    // 2. cannot extend: Caller reaches the target only by continuing past
    // that same guess, one hop further out — it must not appear either.
    expect(guessedImpact).not.toContain('svc2.Caller');

    // 3. a chain of certain edges (Target <- M1 <- M2 <- M3, each an exact
    // qualified-name match) is unaffected and walked in full.
    const certainImpact = store.impact('svc2.Target').map((n) => n.qname).sort();
    expect(certainImpact).toEqual(['svc2.M1', 'svc2.M2', 'svc2.M3']);

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
    // impactSkippedGuesses reads the same missing column through the same
    // guard; a DB with no notion of "guess" has none to report as skipped.
    expect(ro.impactSkippedGuesses('svc.A.Certain')).toBe(0);
    ro.close();
  }, 30000);
});
