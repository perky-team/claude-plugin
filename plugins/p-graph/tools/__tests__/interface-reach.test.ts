import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-ifacereach-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};
const indexed = async () => {
  const store = openStore(':memory:');
  await indexFull({ root: dir, store, ignorePatterns: [] });
  return store;
};

// Indexing interface methods answers a question that could not be asked before —
// `callers "caddyhttp.Handler.ServeHTTP"` — but on its own it would have taken
// something away. A call written on an interface used to sit in the gap report of
// every concrete implementation, warning the reader that something can reach the
// method that no static tool can name. Once the call resolves to the interface,
// it is no longer unresolved, and that warning would simply vanish: the answer
// would read "no callers ✓ complete" for a method that runs on every request.
//
// So the warning is kept and made better. It used to say "2 call sites missing,
// go and grep"; it now names the interface the calls go through, which is
// something a text search cannot work out at all.
describe('a method reached through an interface', () => {
  const goFixture = () => {
    write('store/store.go', `package store
type Store interface {
	ListGroups() []string
}
`);
    write('store/pg.go', `package store
type Postgres struct{}
func (p *Postgres) ListGroups() []string { return nil }
`);
    write('api/api.go', `package api
import "x/store"
func Serve(st store.Store) []string { return st.ListGroups() }
`);
  };

  it('is reported on the concrete type, with the interface named', async () => {
    goFixture();
    const store = await indexed();

    const rows = store.gapsFor('store.Postgres.ListGroups');
    expect(rows).toEqual([{
      file: 'api/api.go', line: 3, dst_name: 'ListGroups', src_qname: 'api.Serve',
      reason: 'interface', reachable: 1, via: 'store.Store.ListGroups',
    }]);
    store.close();
  }, 30000);

  it('still answers the interface method itself', async () => {
    goFixture();
    const store = await indexed();

    expect(store.callers('store.Store.ListGroups').map((r) => r.qname)).toEqual(['api.Serve']);
    // And the interface's own answer has nothing extra to report: the call IS
    // its call site, not something reaching it from elsewhere.
    expect(store.gapsFor('store.Store.ListGroups')).toEqual([]);
    store.close();
  }, 30000);

  // The rule is the method set, which is how Go decides it. A type that is
  // missing one of the interface's methods does not implement it.
  it('is not reported on a type that does not implement the interface', async () => {
    goFixture();
    write('store/half.go', `package store
type Half struct{}
func (h *Half) ListGroups() []string { return nil }
func (h *Half) Extra() {}
`);
    write('store/short.go', `package store
type Wide interface {
	ListGroups() []string
	Missing()
}
`);
    // A call written THROUGH Wide itself. Without this, the test would pass even
    // if Postgres were wrongly treated as satisfying Wide: there would be no edge
    // on Wide's method to surface either way. With it, a wrong "Postgres
    // implements Wide" call would show up as a second `via` here.
    write('store/callwide.go', `package store
func CallWide(w Wide) []string { return w.ListGroups() }
`);
    const store = await indexed();

    // Postgres has ListGroups but not Missing, so it does not implement Wide —
    // the call through Wide must not be attributed to it.
    expect(store.gapsFor('store.Postgres.ListGroups').map((r) => r.via))
      .toEqual(['store.Store.ListGroups']);
    store.close();
  }, 30000);

  // TypeScript has the same shape, and it now has interface methods too.
  it('works the same in TypeScript', async () => {
    write('src/a.ts', `export interface Serializer {
  serialize(v: string): string;
}
export class Json implements Serializer {
  serialize(v: string): string { return v; }
}
export function run(s: Serializer) {
  return s.serialize('x');
}
`);
    const store = await indexed();

    expect(store.gapsFor('Json.serialize').map((r) => `${r.via} at ${r.file}:${r.line}`))
      .toEqual(['Serializer.serialize at src/a.ts:8']);
    store.close();
  }, 30000);

  // A TypeScript interface member written `after?(): void` is optional: a class
  // may leave it out and still legally implement the interface. Before this
  // fix, `need` demanded every member's name, optional or not, so `Only` read
  // as NOT implementing `Hooks` — one missing name was enough to refuse the
  // whole interface — and the call to `before` through `Hooks` silently
  // dropped out of `Only.before`'s answer.
  it('does not demand an optional member the interface declares', async () => {
    write('src/a.ts', `export interface Hooks {
  before(v: string): string;
  after?(): void;
}
export class Only implements Hooks {
  before(v: string): string { return v; }
}
export function run(h: Hooks) {
  return h.before('x');
}
`);
    const store = await indexed();

    expect(store.gapsFor('Only.before')).toEqual([{
      file: 'src/a.ts', line: 9, dst_name: 'before', src_qname: 'run',
      reason: 'interface', reachable: 1, via: 'Hooks.before',
    }]);
    store.close();
  }, 30000);

  // An empty interface is satisfied by everything, so it can never say anything
  // useful about which type runs.
  it('ignores an interface with no methods', async () => {
    write('a/a.go', `package a
type Any interface{}
type T struct{}
func (t *T) Do() {}
`);
    const store = await indexed();

    expect(store.gapsFor('a.T.Do')).toEqual([]);
    store.close();
  }, 30000);
});
