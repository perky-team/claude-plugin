import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

const CLI = join(process.cwd(), 'plugins/p-graph/tools/pgraph.mjs');
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-trace-'));
  mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });

// The first hop is certain: `m: Middle` states its type, so Pass F links `m.hop()`
// to `Middle.hop` as a recorded fact, not a guess. The second hop stays a guess —
// `new Target().reallyUniqueSink()` calls a method on a `new` expression's result
// directly, not on a bound name, so there is no key for a field-type row to attach
// to and it can only fall back to the unique-bare-name match. `impact` on the sink
// already refuses to follow an unresolved-type guess, so `trace` printing the same
// path as a plain fact made the two commands answer opposite things about one graph.
const TWO_GUESSED_HOPS = `class Middle {
  hop() { new Target().reallyUniqueSink(); }
}
class Target {
  reallyUniqueSink() {}
}
export function entry(m: Middle) { m.hop(); }
`;

describe('trace says how sure each hop is', () => {
  it('marks a guessed hop in the text output and reports it in --json', () => {
    write('a.ts', TWO_GUESSED_HOPS);
    run(['index', '--full']);

    const json = JSON.parse(run(['trace', 'entry', 'Target.reallyUniqueSink', '--json']));
    expect(json.path).toEqual(['entry', 'Middle.hop', 'Target.reallyUniqueSink']);
    // One flag per arrow, so a reader can tell WHICH hop is unsure. The first hop
    // is now certain (Middle is a stated type), the second is still a guess.
    expect(json.guessed_hops).toEqual([false, true]);
    expect(json.certain).toBe(false);

    const text = run(['trace', 'entry', 'Target.reallyUniqueSink']);
    expect(text).toContain('entry -> Middle.hop -(guess)-> Target.reallyUniqueSink');
    expect(text).toContain('UNVERIFIED: 1 of 2 hops');
  }, 30000);

  it('leaves a fully certain path unmarked', () => {
    write('a.ts', 'function foo() { bar(); }\nfunction bar() { baz(); }\nfunction baz() {}');
    run(['index', '--full']);

    const json = JSON.parse(run(['trace', 'foo', 'baz', '--json']));
    expect(json.path).toEqual(['foo', 'bar', 'baz']);
    expect(json.guessed_hops).toEqual([false, false]);
    expect(json.certain).toBe(true);

    const text = run(['trace', 'foo', 'baz']);
    expect(text).toContain('foo -> bar -> baz');
    expect(text).not.toContain('guess');
    expect(text).not.toContain('UNVERIFIED');
  }, 30000);

  it('says nothing about confidence when there is no path at all', () => {
    write('a.ts', 'function foo() {}\nfunction baz() {}');
    run(['index', '--full']);

    const json = JSON.parse(run(['trace', 'foo', 'baz', '--json']));
    expect(json.path).toBeNull();
    expect(json.guessed_hops).toBeNull();
    expect(json.certain).toBeNull();
    // The existing "a real path may be invisible" line still has to work.
    expect(run(['trace', 'foo', 'baz'])).toContain('(no path)');
  }, 30000);

  it('prefers a longer certain path over a shorter guessed one', async () => {
    // Entry reaches svc.A.Sink two ways: straight through a guessed edge (two
    // nodes), or through Mid, where both hops are exact qualified matches
    // (three nodes). Plain shortest-path picks the guessed one.
    write('svc/svc.go', `package svc
type A struct{}
func (a *A) Sink() {}
func Mid(a *A) { a.Sink() }
func Make() (*A, error) { return &A{}, nil }
func Entry(a *A) {
	x, _ := Make()
	x.Sink()
	Mid(a)
}
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // Guard the fixture first: without both edges present this proves nothing.
    const into = store.callers('svc.A.Sink');
    expect(into.map((r) => r.qname).sort()).toEqual(['svc.Entry', 'svc.Mid']);

    const t = store.trace('svc.Entry', 'svc.A.Sink');
    expect(t.path).toEqual(['svc.Entry', 'svc.Mid', 'svc.A.Sink']);
    expect(t.guessed).toEqual([false, false]);

    store.close();
  }, 30000);
});
