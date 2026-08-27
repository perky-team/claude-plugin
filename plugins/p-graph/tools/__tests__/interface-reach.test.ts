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

  // The name does not always start the signature line. `readonly` sits in front
  // of an optional property, and a detector that just reads the character at
  // `name.length` reads `readonly`'s own `n` there and misses the `?` — the
  // member then stays demanded, `Only` reads as not implementing `Hooks`, and
  // the true interface-reach row for `before` disappears.
  it('does not demand an optional member written with `readonly` in front', async () => {
    write('src/a.ts', `export interface Hooks {
  before(v: string): string;
  readonly after?: () => void;
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

  // TypeScript also allows whitespace between the name and the `?`. Same
  // failure mode as `readonly` above: the character read at `name.length` is
  // the space, not the `?`, so the member stays demanded.
  it('does not demand an optional member with a space before the `?`', async () => {
    write('src/a.ts', `export interface Hooks {
  before(v: string): string;
  after ?(): void;
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

// Go's compiler demands an exact signature, so the exact comparison
// (shapeSatisfies in local-sqlite.mjs) is right for Go — but TypeScript is
// structurally typed and looser in two ways an exact match gets wrong. These
// three fixtures are the ones a reviewer found reading `✓ complete` at head
// (they printed the `ℹ` row correctly at the merge base, before the shape
// check existed): a member whose parameter list wraps onto the next line, an
// implementation that legally declares fewer parameters than the interface,
// and an implementation that legally drops the interface's return annotation.
describe("TypeScript's looser shape rule", () => {
  // `signature` is only the FIRST LINE of a declaration (see driver.mjs). A
  // member whose parameter list continues on the next line — common in nest,
  // e.g. `canActivate(` — leaves `sigShape` nothing to read: `group()` never
  // finds the closing paren on that one line, so it returns null. Before this
  // fix, a null shape on EITHER side made the whole method refuse; now it
  // falls back to the name-only rule instead.
  it('does not refuse a member whose parameter list wraps onto the next line', async () => {
    write('src/a.ts', `export interface CanActivate {
  canActivate(
    context: string,
  ): boolean;
}
export class Guard implements CanActivate {
  canActivate(context: string): boolean { return true; }
}
export function run(g: CanActivate) {
  return g.canActivate('x');
}
`);
    const store = await indexed();

    expect(store.gapsFor('Guard.canActivate')).toEqual([{
      file: 'src/a.ts', line: 10, dst_name: 'canActivate', src_qname: 'run',
      reason: 'interface', reachable: 1, via: 'CanActivate.canActivate',
    }]);
    store.close();
  }, 30000);

  // `transform(value)` legally implements `transform(value, metadata)` — a
  // NestJS pipe is free to ignore the metadata argument. The old exact rule
  // refused this (1 param vs 2); the new rule only demands the implementation
  // take no MORE parameters than the interface.
  it('does not refuse an implementation with fewer parameters than the interface', async () => {
    write('src/a.ts', `export interface PipeTransform {
  transform(value: string, metadata: string): string;
}
export class Trim implements PipeTransform {
  transform(value) { return value; }
}
export function run(p: PipeTransform) {
  return p.transform('x', 'y');
}
`);
    const store = await indexed();

    expect(store.gapsFor('Trim.transform')).toEqual([{
      file: 'src/a.ts', line: 8, dst_name: 'transform', src_qname: 'run',
      reason: 'interface', reachable: 1, via: 'PipeTransform.transform',
    }]);
    store.close();
  }, 30000);

  // `onModuleInit() {` legally implements `onModuleInit(): any;` — a return
  // annotation is optional on the class side in TypeScript. The old exact
  // rule compared `hasResult` and refused (true vs false); the new rule does
  // not compare it at all for TypeScript.
  it('does not refuse an implementation that drops the return annotation', async () => {
    write('src/a.ts', `export interface OnModuleInit {
  onModuleInit(): any;
}
export class Service implements OnModuleInit {
  onModuleInit() { }
}
export function run(s: OnModuleInit) {
  return s.onModuleInit();
}
`);
    const store = await indexed();

    expect(store.gapsFor('Service.onModuleInit')).toEqual([{
      file: 'src/a.ts', line: 8, dst_name: 'onModuleInit', src_qname: 'run',
      reason: 'interface', reachable: 1, via: 'OnModuleInit.onModuleInit',
    }]);
    store.close();
  }, 30000);
});

// The pair the study measured this on: caddy's three-parameter
// `MiddlewareHandler` form of `ServeHTTP` against the two-parameter interface
// method. Go must still refuse it — TypeScript's looser rule (previous
// describe block) is only for TypeScript. Checked from the interface side
// (implementationReach), the mirror of the interfaceReach checks above.
describe("Go's exact shape rule, still enforced", () => {
  it('refuses a three-parameter Go method against a two-parameter interface method', async () => {
    write('store/handler.go', `package store
type Handler interface {
	ServeHTTP(w string, r string) error
}
`);
    write('store/chain.go', `package store
type Chain struct{}
func (c *Chain) ServeHTTP(w string, r string, next Handler) error { return nil }
`);
    write('api/api.go', `package api
import "x/store"
func Serve(c *store.Chain, h store.Handler) error {
	c.ServeHTTP("w", "r", h)
	return h.ServeHTTP("w", "r")
}
`);
    const store = await indexed();

    // Chain's three-parameter ServeHTTP must not be reported as an
    // implementation of Handler's two-parameter one, even though it has a
    // direct call site of its own (line 4) that a wrongly-accepted match
    // would surface here.
    expect(store.gapsFor('store.Handler.ServeHTTP')).toEqual([]);
    store.close();
  }, 30000);

  // caddy's other correct refusal: the standard library's void `ServeHTTP(w,
  // r) {` form, same param count as the interface but no result. A pair like
  // this is the one that actually tells "Go kept its own rule" apart from "Go
  // quietly started sharing TypeScript's rule": both forms have the same
  // param count, so the permissive TS rule (which ignores hasResult) would
  // wrongly accept this pair too — only a real hasResult comparison refuses
  // it. The three-parameter test above does not: a bigger param count is
  // refused by the permissive rule as well, so that test alone could not
  // catch Go silently losing its own branch.
  it('refuses a same-arity Go method whose result differs from the interface', async () => {
    write('store/handler.go', `package store
type Handler interface {
	ServeHTTP(w string, r string) error
}
`);
    write('store/plain.go', `package store
type Plain struct{}
func (p *Plain) ServeHTTP(w string, r string) {}
`);
    write('api/api.go', `package api
import "x/store"
func Serve(p *store.Plain, h store.Handler) error {
	p.ServeHTTP("w", "r")
	return h.ServeHTTP("w", "r")
}
`);
    const store = await indexed();

    expect(store.gapsFor('store.Handler.ServeHTTP')).toEqual([]);
    store.close();
  }, 30000);
});

// Store-level, not source-level like every test above — deliberately, not out of
// laziness. `interface Codec { encode(v: string): string; encode(v: string, pad:
// number): string; }` is everyday TypeScript (overloads), and both members are
// nodes on the same qname, `Codec.encode`. A call written through a Codec-typed
// value CANNOT get a `dst_id` today: every resolver pass that links a call to a
// qualified name (local-sqlite.mjs's Pass F, Pass B, and TS's own field-type pass)
// requires exactly one node to answer to that qname, and two overloads means two.
// That is a real, separate bug in the call resolver, upstream of interfaceReach,
// and out of scope here (confirmed: identical CLI output before and after the fix
// below, and on the commit before this task's changes too).
//
// So the graph is built by hand instead, the same way store-fieldtypes.test.ts and
// store-read.test.ts do — inserting nodes and a call edge whose `dst_id` is set
// exactly as a resolver that COULD handle overloads would set it. That isolates
// the one thing interfaceReach's satisfaction check controls (does a same-named
// member's shape match) from the resolver problem that sits in front of it.
describe('a class satisfying one TypeScript overload out of several (store-level)', () => {
  it('reports the call when the class matches a LATER overload, not the first', () => {
    const store = openStore(':memory:');
    const nodes = [
      { id: 'iface1', name: 'Codec', qname: 'Codec', kind: 'interface', lang: 'ts',
        file: 'a.ts', start_line: 1, end_line: 4, signature: 'export interface Codec {',
        doc: '', container_id: null },
      // Two overloads of one name, at different lines, different shapes — what the
      // earlier ts.scm fix now records for a real interface.
      { id: 'm1', name: 'encode', qname: 'Codec.encode', kind: 'method', lang: 'ts',
        file: 'a.ts', start_line: 2, end_line: 2, signature: 'encode(v: string): string;',
        doc: '', container_id: 'iface1' },
      { id: 'm2', name: 'encode', qname: 'Codec.encode', kind: 'method', lang: 'ts',
        file: 'a.ts', start_line: 3, end_line: 3,
        signature: 'encode(v: string, pad: number): string;', doc: '', container_id: 'iface1' },
      { id: 'cls1', name: 'Impl', qname: 'Impl', kind: 'class', lang: 'ts',
        file: 'a.ts', start_line: 5, end_line: 7,
        signature: 'export class Impl implements Codec {', doc: '', container_id: null },
      // Impl implements the SECOND overload's shape (two params) — not the first.
      { id: 'im1', name: 'encode', qname: 'Impl.encode', kind: 'method', lang: 'ts',
        file: 'a.ts', start_line: 6, end_line: 6,
        signature: 'encode(v: string, pad: number): string { return v; }', doc: '',
        container_id: 'cls1' },
      { id: 'fn1', name: 'run', qname: 'run', kind: 'function', lang: 'ts',
        file: 'a.ts', start_line: 8, end_line: 10,
        signature: 'export function run(c: Codec) {', doc: '', container_id: null },
    ];
    // The call `c.encode('x', 1)`. `dst_id` points at `m2`, the SECOND overload —
    // the one whose shape (two params) matches what was actually called, exactly
    // as a resolver able to tell overloads apart would have set it.
    const edges = [
      { src_id: 'fn1', dst_id: 'm2', dst_name: 'encode', kind: 'call', file: 'a.ts',
        line: 9, field_key: null, method: 'encode', dst_bare: 'encode', lang: 'ts',
        external: 0, member: 1 },
    ];
    store.replaceFileSymbols('a.ts', nodes, edges);

    // Before the fix, interfaceReach compared Impl.encode only against `m1` (the
    // first same-named member `find()` returned) and refused: `m1`'s one-param
    // shape does not match Impl.encode's two params. The call is real and
    // resolved, but the old code would still call this method complete.
    expect(store.gapsFor('Impl.encode')).toEqual([{
      file: 'a.ts', line: 9, dst_name: 'encode', src_qname: 'run',
      reason: 'interface', reachable: 1, via: 'Codec.encode',
    }]);
    store.close();
  }, 30000);
});
