import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-impldecl-')); });
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
// The `via` of every "an implementation of this interface runs here" row, which is
// what the `ℹ N call sites of this method — on X, which implements it` heading
// prints. One row per call site, so the list is de-duplicated.
const implementationVia = (store, name) => [...new Set(store.gapsFor(name)
  .filter((r) => r.reason === 'implementation').map((r) => r.via))].sort();
// The `via` of every "this call runs through an interface method" row — the
// MIRROR direction, asked about a class method rather than an interface one. It
// prints as `ℹ N call site reaches this method through X`.
const interfaceVia = (store, name) => [...new Set(store.gapsFor(name)
  .filter((r) => r.reason === 'interface').map((r) => r.via))].sort();

// Asked about a method an interface declares, p-graph reports the call sites of
// every type that implements the interface. Until now "implements" was guessed
// from shape alone: the type had to carry a method of every name the interface
// declares, and the asked-about method's parameter count had to fit. For a
// SINGLE-METHOD interface that reduces to "the type has a method of this name",
// and nest has 312 interfaces with many declaring one method.
//
// TypeScript writes down what a class implements, so the graph no longer has to
// guess. The rule, and each case below checks one line of it:
//
//   1. Collect the interface names the candidate's owner declares.
//   2. Declares none — every Go type, every JavaScript class, a structurally
//      typed TypeScript class — keep the old name-and-shape rule untouched.
//   3. Declares some and one names this interface, directly or through one
//      `#alias:` hop — let it through.
//   4. Declares some and ANY of them resolves to nothing the graph knows —
//      keep the old rule. A half-read picture must not lose a true row.
//   5. Only when every declared name resolves to a known repo interface and none
//      of them is this one — skip the candidate.
describe('a class implements what it says it implements', () => {
  // The measured case. `ClassSerializerInterceptor` in nest declares
  // `implements NestInterceptor` and lives in another package; the only thing it
  // shares with `Serializer` is a method named `serialize`. Its 13 call sites per
  // run were the only source of invented rows in the whole four-language study
  // (TypeScript 39, Go 0, Python 0, C++ 0).
  it('does not call a class an implementation when it declares another interface', async () => {
    write('micro/serializer.interface.ts', `export interface Serializer {
  serialize(value: unknown, options?: Record<string, any>): string;
}
`);
    write('micro/identity.serializer.ts', `import { Serializer } from './serializer.interface';
export class IdentitySerializer implements Serializer {
  serialize(value: unknown) { return String(value); }
}
`);
    // The interface the interceptor really declares. nest declares it, in the same
    // package as the interceptor, and rule 4 needs it here too: a name the graph
    // cannot resolve keeps the old rule, so without this interface the class would
    // be kept and this test would pass for the wrong reason.
    write('common/nest-interceptor.interface.ts', `export interface NestInterceptor {
  intercept(context: unknown, next: unknown): unknown;
}
`);
    write('common/class-serializer.interceptor.ts', `import { NestInterceptor } from './nest-interceptor.interface';
export class ClassSerializerInterceptor implements NestInterceptor {
  intercept(context: unknown, next: unknown) { return next; }
  serialize(value: unknown) { return String(value); }
}
`);
    write('common/use.ts', `import { ClassSerializerInterceptor } from './class-serializer.interceptor';
export function run(i: ClassSerializerInterceptor) { return i.serialize(1); }
`);
    write('micro/use.ts', `import { IdentitySerializer } from './identity.serializer';
export function run(s: IdentitySerializer) { return s.serialize(1); }
`);
    const store = await indexed();

    const via = implementationVia(store, 'Serializer.serialize');
    expect(via).toContain('IdentitySerializer.serialize');
    expect(via).not.toContain('ClassSerializerInterceptor.serialize');
    store.close();
  }, 30000);

  // Rule 2, and the one that must not move. A Go type never declares what it
  // implements; its method set IS the whole rule, so name-and-shape is not a
  // guess there, it is how the language decides. This is the test that stops the
  // fix leaking out of TypeScript. The shape is caddy's: one interface method,
  // two types that carry it, a call on each.
  it('still reports every Go type whose method set fits the interface', async () => {
    write('store/handler.go', `package store
type Handler interface {
	ServeHTTP(w string) error
}
`);
    write('store/one.go', `package store
type One struct{}
func (o *One) ServeHTTP(w string) error { return nil }
`);
    write('store/two.go', `package store
type Two struct{}
func (t *Two) ServeHTTP(w string) error { return nil }
`);
    write('api/api.go', `package api
import "x/store"
func Serve(o *store.One, t *store.Two) error {
	o.ServeHTTP("w")
	return t.ServeHTTP("w")
}
`);
    const store = await indexed();

    expect(implementationVia(store, 'store.Handler.ServeHTTP'))
      .toEqual(['store.One.ServeHTTP', 'store.Two.ServeHTTP']);
    store.close();
  }, 30000);

  // Rule 2 in TypeScript. TypeScript is structurally typed: a class that fits an
  // interface implements it whether it says so or not, and plenty of nest classes
  // are written that way. A class with no clause declares nothing, so the old rule
  // still decides.
  it('still reports a TypeScript class that declares nothing at all', async () => {
    write('src/a.ts', `export interface Serializer {
  serialize(value: unknown): string;
}
export class Loose {
  serialize(value: unknown) { return String(value); }
}
export function run(l: Loose) { return l.serialize(1); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['Loose.serialize']);
    store.close();
  }, 30000);

  // Rule 2 in JavaScript, and it has to be built by hand rather than written as
  // source — deliberately, not out of laziness. JavaScript has no `implements`
  // syntax and no `interface` syntax either, so `js.scm` makes no interface node,
  // and today the candidate scan matches `lang` exactly ('ts' candidates for a
  // 'ts' interface method). A `.js` class can therefore never reach this code from
  // real source, and a source fixture would pin nothing.
  //
  // The case is still worth pinning: it is the guard's language-agnostic half. No
  // `#implements:` row exists for a JavaScript class — nothing writes one — so the
  // guard must have no opinion and hand the candidate to the old rule. If the
  // candidate scan is ever widened to the ts/js family (every type-reading pass in
  // local-sqlite.mjs already says `lang IN ('ts','js')`), this is what stops every
  // JavaScript class dropping out of the answer on that day.
  it('keeps a JavaScript class, which can never carry a declaration (store-level)', () => {
    const store = openStore(':memory:');
    const nodes = [
      { id: 'iface1', name: 'Serializer', qname: 'Serializer', kind: 'interface', lang: 'js',
        file: 'a.js', start_line: 1, end_line: 3, signature: 'interface Serializer {',
        doc: '', container_id: null },
      { id: 'm1', name: 'serialize', qname: 'Serializer.serialize', kind: 'method', lang: 'js',
        file: 'a.js', start_line: 2, end_line: 2, signature: 'serialize(v) {', doc: '',
        container_id: 'iface1' },
      { id: 'cls1', name: 'Plain', qname: 'Plain', kind: 'class', lang: 'js',
        file: 'a.js', start_line: 4, end_line: 6, signature: 'class Plain {', doc: '',
        container_id: null },
      { id: 'im1', name: 'serialize', qname: 'Plain.serialize', kind: 'method', lang: 'js',
        file: 'a.js', start_line: 5, end_line: 5, signature: 'serialize(v) {', doc: '',
        container_id: 'cls1' },
      { id: 'fn1', name: 'run', qname: 'run', kind: 'function', lang: 'js',
        file: 'a.js', start_line: 7, end_line: 9, signature: 'function run(p) {',
        doc: '', container_id: null },
    ];
    const edges = [
      { src_id: 'fn1', dst_id: 'im1', dst_name: 'serialize', kind: 'call', file: 'a.js',
        line: 8, field_key: null, method: 'serialize', dst_bare: 'serialize', lang: 'js',
        external: 0, member: 1 },
    ];
    store.replaceFileSymbols('a.js', nodes, edges);

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['Plain.serialize']);
    store.close();
  }, 30000);

  // Rule 3. nest writes exactly this: `type ProducerSerializer = Serializer<ReadPacket,
  // ProducerRecord>` and `class KafkaRequestSerializer implements ProducerSerializer`.
  // No interface is called ProducerSerializer, so without following the alias the
  // declared name resolves to nothing, rule 4 fires, and the row survives by luck
  // rather than by being right. One hop, the same hop `resolveTsFieldTypes` follows.
  it('accepts a class that names the interface through a type alias', async () => {
    write('src/serializer.interface.ts', `export interface Serializer<TIn, TOut> {
  serialize(value: TIn): TOut;
}
`);
    write('src/producer.ts', `import { Serializer } from './serializer.interface';
export type ProducerSerializer = Serializer<string, string>;
export class Producer implements ProducerSerializer {
  serialize(value: string) { return value; }
}
`);
    write('src/use.ts', `import { Producer } from './producer';
export function run(p: Producer) { return p.serialize('x'); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['Producer.serialize']);
    store.close();
  }, 30000);

  // The alias hop, checked in the direction that can actually fail. The case above
  // cannot: drop the hop and `ProducerSerializer` resolves to nothing, rule 4 fires,
  // and the row is kept anyway — right answer, wrong reason. Here the alias names a
  // DIFFERENT interface, so the hop is the only thing that turns "declares something
  // the graph cannot read" into "declares Other, which is not what you asked about".
  it('follows the alias when it names a different interface, and skips the class', async () => {
    write('src/serializer.interface.ts', `export interface Serializer {
  serialize(value: unknown): string;
}
export interface Other {
  other(): void;
}
`);
    write('src/side.ts', `import { Other } from './serializer.interface';
export type OtherAlias = Other;
export class Side implements OtherAlias {
  other() { }
  serialize(value: unknown) { return String(value); }
}
`);
    write('src/use.ts', `import { Side } from './side';
export function run(s: Side) { return s.serialize(1); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual([]);
    store.close();
  }, 30000);

  // Rule 4. The graph cannot see what `SomethingNotInThisRepo` is — it may well be
  // the interface being asked about, re-exported or renamed on the way in. So the
  // clause says nothing usable and the old rule still decides.
  //
  // This is not caution for its own sake. `ts.scm` reads no members off an
  // interface's own `extends` clause, so `interface Wide extends Serializer {}`
  // gives `Wide` a SHORT member set, and a class writing `implements Wide` would be
  // refused by an exact-name check even though it really does implement the target.
  it('keeps a class whose declared interface the graph cannot resolve', async () => {
    write('src/a.ts', `export interface Serializer {
  serialize(value: unknown): string;
}
export class Q implements SomethingNotInThisRepo {
  serialize(value: unknown) { return String(value); }
}
export function run(q: Q) { return q.serialize(1); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['Q.serialize']);
    store.close();
  }, 30000);

  // Rule 4 again, and the case that matters most: `implements X` where
  // `interface X extends Serializer` IS an implementation of `Serializer`, so the
  // check has to walk what the declared interface itself extends.
  //
  // Measured on nest. `ExecutionContextHost` declares `implements ExecutionContext`
  // and `interface ExecutionContext extends ArgumentsHost`, so it really does
  // implement `ArgumentsHost`. Comparing the declared name alone dropped all 5 true
  // `ArgumentsHost.*` rows — `getArgs`, `getArgByIndex`, `switchToHttp`,
  // `switchToRpc`, `switchToWs`. Nothing stores an interface's own bases (`ts.scm`
  // captures `extends` only inside a class heritage), so they are read off the
  // interface's declaration line.
  it('accepts a class whose declared interface extends the one asked about', async () => {
    write('src/a.ts', `export interface Serializer {
  serialize(value: unknown): string;
}
export interface Wide extends Serializer {
  reset(): void;
}
export class W implements Wide {
  serialize(value: unknown) { return String(value); }
  reset() { }
}
export function run(w: W) { return w.serialize(1); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['W.serialize']);
    store.close();
  }, 30000);

  // Two hops of the same chain, and the base written with type arguments. nest
  // writes both — `interface INestMicroservice extends INestApplicationContext`,
  // `interface NestInterceptor<T = any, R = any>`.
  it('walks the extends chain further than one step', async () => {
    write('src/a.ts', `export interface Serializer<T> {
  serialize(value: T): string;
}
export interface Middle extends Serializer<string> {
  middle(): void;
}
export interface Wide extends Middle {
  reset(): void;
}
export class W implements Wide {
  serialize(value: string) { return value; }
  middle() { }
  reset() { }
}
export function run(w: W) { return w.serialize('x'); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['W.serialize']);
    store.close();
  }, 30000);

  // A declaration line that does NOT hold the whole heritage. `signature` is only
  // the first line of a declaration, so a base named on the next line is invisible
  // here — and "invisible" must not be read as "extends nothing". nest writes this
  // too: `export interface RequestContext<` puts its type parameters, and could put
  // its bases, on later lines.
  it('keeps a class when the declared interface heritage runs past its first line', async () => {
    write('src/a.ts', `export interface Serializer {
  serialize(value: unknown): string;
}
export interface Wide
  extends Serializer {
  reset(): void;
}
export class W implements Wide {
  serialize(value: unknown) { return String(value); }
  reset() { }
}
export function run(w: W) { return w.serialize(1); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['W.serialize']);
    store.close();
  }, 30000);

  // A base the graph has never seen. Whatever `SomewhereElse` promises, the graph
  // cannot say it is not the interface asked about, so the old rule decides.
  it('keeps a class when the declared interface extends something unknown', async () => {
    write('src/a.ts', `export interface Serializer {
  serialize(value: unknown): string;
}
export interface Wide extends SomewhereElse {
  reset(): void;
}
export class W implements Wide {
  serialize(value: unknown) { return String(value); }
  reset() { }
}
export function run(w: W) { return w.serialize(1); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['W.serialize']);
    store.close();
  }, 30000);

  // `extends` in a declaration line does not always name a base: `interface
  // Wide<T extends Serializer>` only constrains a type parameter, and a class
  // implementing `Wide` does NOT implement `Serializer`. The reader cannot tell the
  // two apart safely, so it calls the line unreadable and the old rule decides —
  // the row stays. Over-cautious on purpose: the precise answer here would be to
  // skip, and choosing to keep costs precision instead of recall.
  //
  // nest writes this shape (`interface RequestContext<TData = any, TContext extends
  // BaseRpcContext = any>`), which is why it is pinned.
  it('keeps a class when the declared interface only constrains a type parameter', async () => {
    write('src/a.ts', `export interface Serializer {
  serialize(value: unknown): string;
}
export interface Wide<T extends Serializer> { reset(): void; }
export class W implements Wide<any> {
  serialize(value: unknown) { return String(value); }
  reset() { }
}
export function run(w: W) { return w.serialize(1); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['W.serialize']);
    store.close();
  }, 30000);

  // Rule 5, the boundary. Two declared names, the repo defines both as interfaces,
  // and neither is the one asked about. Every name resolved, so the clause is a
  // complete answer to "what does this class implement", and the answer is "not
  // this". Only now is the candidate dropped.
  it('skips a class whose declared interfaces are all known and none is this one', async () => {
    write('src/a.ts', `export interface Serializer {
  serialize(value: unknown): string;
}
export interface Alpha {
  alpha(): void;
}
export interface Beta {
  beta(): void;
}
export class R implements Alpha, Beta {
  alpha() { }
  beta() { }
  serialize(value: unknown) { return String(value); }
}
export function run(r: R) { return r.serialize(1); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual([]);
    store.close();
  }, 30000);

  // Rule 5 must read the candidate's OWN clause. Two classes of one name share the
  // class-wide `<Class>#implements:<Iface>` key, so the file-scoped twin is what
  // tells them apart — the same precedence `resolveTsFieldTypes` uses for a field
  // type.
  //
  // Built by hand, again for a reason rather than out of laziness. Two classes of
  // one name in real source means `classByName` holds two entries for `Dup`, every
  // TypeScript resolver pass demands exactly one, and so NO call on a `Dup` ever
  // resolves — there would be no row to keep or drop, and the fixture would pass
  // whatever the guard did. Inserting the nodes, the two `implements` clauses and
  // one resolved call per class puts the precedence itself under test.
  it('reads the clause of the candidate own file, not another class of the same name', () => {
    const store = openStore(':memory:');
    const iface = [
      { id: 'iface1', name: 'Serializer', qname: 'Serializer', kind: 'interface', lang: 'ts',
        file: 'src/i.ts', start_line: 1, end_line: 3,
        signature: 'export interface Serializer {', doc: '', container_id: null },
      { id: 'm1', name: 'serialize', qname: 'Serializer.serialize', kind: 'method', lang: 'ts',
        file: 'src/i.ts', start_line: 2, end_line: 2,
        signature: 'serialize(value: unknown): string;', doc: '', container_id: 'iface1' },
      { id: 'iface2', name: 'Other', qname: 'Other', kind: 'interface', lang: 'ts',
        file: 'src/i.ts', start_line: 4, end_line: 6,
        signature: 'export interface Other {', doc: '', container_id: null },
      { id: 'm2', name: 'other', qname: 'Other.other', kind: 'method', lang: 'ts',
        file: 'src/i.ts', start_line: 5, end_line: 5, signature: 'other(): void;',
        doc: '', container_id: 'iface2' },
    ];
    store.replaceFileSymbols('src/i.ts', iface, []);
    // Each file declares its own `Dup`, and each writes BOTH keys, exactly as the
    // extractor does. The class-wide key therefore holds `Serializer` and `Other`
    // together; only the file-scoped key separates them.
    const dupFile = (file, declares, line) => {
      const nodes = [
        { id: `${file}:cls`, name: 'Dup', qname: 'Dup', kind: 'class', lang: 'ts',
          file, start_line: 1, end_line: 3,
          signature: declares ? `export class Dup implements ${declares} {` : 'export class Dup {',
          doc: '', container_id: null },
        { id: `${file}:m`, name: 'serialize', qname: 'Dup.serialize', kind: 'method', lang: 'ts',
          file, start_line: 2, end_line: 2,
          signature: 'serialize(value: unknown) { return String(value); }', doc: '',
          container_id: `${file}:cls` },
        { id: `${file}:fn`, name: 'run', qname: 'run', kind: 'function', lang: 'ts',
          file, start_line: 4, end_line: 4, signature: 'export function run(d: Dup) {',
          doc: '', container_id: null },
      ];
      const edges = [
        { src_id: `${file}:fn`, dst_id: `${file}:m`, dst_name: 'serialize', kind: 'call',
          file, line, field_key: null, method: 'serialize', dst_bare: 'serialize',
          lang: 'ts', external: 0, member: 1 },
      ];
      const fieldTypes = declares ? [
        { key: `Dup#implements:${declares}`, type: '1', file },
        { key: `${file}|Dup#implements:${declares}`, type: '1', file },
      ] : [];
      store.replaceFileSymbols(file, nodes, edges, fieldTypes);
    };
    dupFile('one/dup.ts', 'Serializer', 4);
    dupFile('two/dup.ts', 'Other', 4);
    // A third `Dup` that declares NOTHING. It is the case the class-wide key gets
    // wrong in the other direction: this class disclaims nothing, so the old rule
    // must decide and its row must stay. Measured on nest, 13 class names look like
    // this — `TestModule` lives in 20 files and 2 of them declare a clause.
    dupFile('three/dup.ts', null, 4);

    // A reader that took the class-wide key would find `Serializer` in `two/dup.ts`'s
    // clause too and keep a row that class's own declaration refuses — and would
    // find `Other` in `three/dup.ts`'s and drop a row nothing refused.
    const rows = store.gapsFor('Serializer.serialize')
      .filter((r) => r.reason === 'implementation');
    expect(rows.map((r) => `${r.file}:${r.line}`)).toEqual(['one/dup.ts:4', 'three/dup.ts:4']);
    store.close();
  }, 30000);

  // The clause can sit on the BASE class. `class C extends BaseSerializer
  // implements Other` really does implement `Serializer` — nominally, through its
  // base, not merely structurally — so that row is true, and reading only the
  // class's own clause threw it away silently. A false row is at least visible; a
  // lost true row is not.
  //
  // Reproduced through the real indexer: the base class in another file, a plain
  // override. The code before this branch answered `["C.serialize"]`; reading the
  // own clause alone answered `[]`.
  //
  // The data was already stored and this file already walks it: `<Class>#extends`
  // is the same row `resolveTsFieldTypes` follows to find a field declared on a
  // base class. So the clause of every class up the base chain is unioned with the
  // class's own.
  //
  // nest could not have shown this: it holds exactly ONE `class … extends …
  // implements …` under `packages/`, and that one's base is a Node library class.
  it('accepts a class that inherits the clause from its base class', async () => {
    write('src/serializer.interface.ts', `export interface Serializer {
  serialize(value: unknown): string;
}
export interface Other {
  other(): void;
}
`);
    write('src/base.ts', `import { Serializer } from './serializer.interface';
export class BaseSerializer implements Serializer {
  serialize(value: unknown) { return String(value); }
}
`);
    write('src/c.ts', `import { BaseSerializer } from './base';
import { Other } from './serializer.interface';
export class C extends BaseSerializer implements Other {
  serialize(value: unknown) { return 'c' + String(value); }
  other() { }
}
export function run(c: C) { return c.serialize(1); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['C.serialize']);
    store.close();
  }, 30000);

  // Two steps up the base chain, and the base of the base is the one that
  // declares. The walk is capped by a `seen` set rather than a hop count, so a
  // deep hierarchy costs nothing and a cycle cannot spin.
  it('walks the base class chain further than one step', async () => {
    write('src/serializer.interface.ts', `export interface Serializer {
  serialize(value: unknown): string;
}
export interface Other {
  other(): void;
}
`);
    write('src/root.ts', `import { Serializer } from './serializer.interface';
export class Root implements Serializer {
  serialize(value: unknown) { return String(value); }
}
`);
    write('src/mid.ts', `import { Root } from './root';
export class Mid extends Root { }
`);
    write('src/c.ts', `import { Mid } from './mid';
import { Other } from './serializer.interface';
export class C extends Mid implements Other {
  serialize(value: unknown) { return 'c'; }
  other() { }
}
export function run(c: C) { return c.serialize(1); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['C.serialize']);
    store.close();
  }, 30000);

  // A base class the graph has never seen — a library class. Whatever it declares,
  // the graph cannot read it, so the picture is half-read and the old rule decides.
  // The keep direction, the same as an unresolvable interface name.
  //
  // nest writes exactly this shape once: `class Sink extends Writable implements
  // HeaderStream`, and `Writable` comes from node's `stream`.
  it('keeps a class whose base class is outside the graph', async () => {
    write('src/a.ts', `import { Writable } from 'stream';
export interface Serializer {
  serialize(value: unknown): string;
}
export interface Other {
  other(): void;
}
export class Sink extends Writable implements Other {
  serialize(value: unknown) { return String(value); }
  other() { }
}
export function run(s: Sink) { return s.serialize(1); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['Sink.serialize']);
    store.close();
  }, 30000);

  // The two directions have to give the same answer about one class. Asked about
  // an INTERFACE method, p-graph reports the classes that implement it; asked
  // about a CLASS method, it reports the interface the call runs through. The
  // second path had no declaration check at all, so the graph contradicted itself
  // on the measured fixture:
  //
  //   callers ClassSerializerInterceptor.serialize -> through Serializer.serialize
  //   callers Serializer.serialize                 -> does not list it
  //
  // One of those two answers had to be wrong, and it was the same wrong claim in
  // both cases — the class declares `implements NestInterceptor` and shares
  // nothing with `Serializer` but a method name. Both directions now read the same
  // clause, so they agree.
  it('agrees in both directions about a class that declares another interface', async () => {
    write('micro/serializer.interface.ts', `export interface Serializer {
  serialize(value: unknown, options?: Record<string, any>): string;
}
`);
    write('micro/identity.serializer.ts', `import { Serializer } from './serializer.interface';
export class IdentitySerializer implements Serializer {
  serialize(value: unknown) { return String(value); }
}
`);
    write('common/nest-interceptor.interface.ts', `export interface NestInterceptor {
  intercept(context: unknown, next: unknown): unknown;
}
`);
    write('common/class-serializer.interceptor.ts', `import { NestInterceptor } from './nest-interceptor.interface';
export class ClassSerializerInterceptor implements NestInterceptor {
  intercept(context: unknown, next: unknown) { return next; }
  serialize(value: unknown) { return String(value); }
}
`);
    write('common/use.ts', `import { ClassSerializerInterceptor } from './class-serializer.interceptor';
export function run(i: ClassSerializerInterceptor) { return i.serialize(1); }
`);
    write('micro/use.ts', `import { IdentitySerializer } from './identity.serializer';
export function run(s: IdentitySerializer) { return s.serialize(1); }
`);
    // A call written on a `Serializer`-typed value, so it lands on the INTERFACE
    // method. Without it neither direction has an interface row to report and the
    // check would pass on an empty list.
    write('micro/use-iface.ts', `import { Serializer } from './serializer.interface';
export function runIface(s: Serializer) { return s.serialize(1); }
`);
    const store = await indexed();

    // Direction one: asked about the interface method.
    expect(implementationVia(store, 'Serializer.serialize'))
      .toEqual(['IdentitySerializer.serialize']);
    // Direction two: asked about the class method. The same clause, the same answer.
    expect(interfaceVia(store, 'ClassSerializerInterceptor.serialize')).toEqual([]);
    // And the class that really does implement it still reads that way both ways.
    expect(interfaceVia(store, 'IdentitySerializer.serialize'))
      .toEqual(['Serializer.serialize']);
    store.close();
  }, 30000);

  // An alias of an alias. `type Mid = Serializer; type Outer = Mid;` and a class
  // writing `implements Outer`. The check follows ONE hop — the same single hop
  // resolveTsFieldTypes follows — so `Outer` lands on `Mid`, which is no interface,
  // and the declared name resolves to nothing. Rule 4 then keeps the row.
  //
  // That is the safe direction and it is already what happens; this pins it as
  // intent rather than luck, so a later reader cannot turn it into a skip without
  // a test going red.
  it('keeps a class that names the interface through two alias hops', async () => {
    write('src/i.ts', `export interface Serializer {
  serialize(value: unknown): string;
}
`);
    write('src/b.ts', `import { Serializer } from './i';
export type Mid = Serializer;
export type Outer = Mid;
export class C implements Outer {
  serialize(value: unknown) { return String(value); }
}
export function run(c: C) { return c.serialize(1); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['C.serialize']);
    store.close();
  }, 30000);

  // One name declared twice, once as an interface and once as an alias of another
  // interface. The clause could mean either, and this file cancels on a
  // disagreement everywhere else — the alias fold does exactly that when two
  // aliases of one name point different ways. Cancelling here means "keep the
  // row", which is the safe direction: preferring the interface would refuse a row
  // that is true under the alias reading.
  it('keeps a class when the declared name is both an interface and an alias', async () => {
    write('src/i.ts', `export interface Serializer {
  serialize(value: unknown): string;
}
export interface Handler {
  handle(): void;
}
`);
    write('src/alias.ts', `import { Serializer } from './i';
export type Handler = Serializer;
`);
    write('src/c.ts', `export class C implements Handler {
  serialize(value: unknown) { return String(value); }
  handle() { }
}
export function run(c: C) { return c.serialize(1); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['C.serialize']);
    store.close();
  }, 30000);

  // Two classes of ONE name in ONE file. They write into the same file-scoped
  // clause key, so their clauses are unioned and a twin that declares nothing
  // would be judged by the other one's clause. Nothing in the graph tells the two
  // apart — the key is all there is — so the reader says nothing and the old rule
  // decides. Both rows stay, which costs precision and never a true row.
  //
  // Built by hand, like the file-scoped precedence case above and for the same
  // reason: two classes of one name in real source means no call on either
  // resolves, so a source fixture would pass whatever the reader did.
  it('says nothing about two classes of one name in one file (store-level)', () => {
    const store = openStore(':memory:');
    const ifaces = [
      { id: 'iface1', name: 'Serializer', qname: 'Serializer', kind: 'interface', lang: 'ts',
        file: 'src/i.ts', start_line: 1, end_line: 3,
        signature: 'export interface Serializer {', doc: '', container_id: null },
      { id: 'm1', name: 'serialize', qname: 'Serializer.serialize', kind: 'method', lang: 'ts',
        file: 'src/i.ts', start_line: 2, end_line: 2,
        signature: 'serialize(value: unknown): string;', doc: '', container_id: 'iface1' },
      { id: 'iface2', name: 'Other', qname: 'Other', kind: 'interface', lang: 'ts',
        file: 'src/i.ts', start_line: 4, end_line: 6,
        signature: 'export interface Other {', doc: '', container_id: null },
      { id: 'm2', name: 'other', qname: 'Other.other', kind: 'method', lang: 'ts',
        file: 'src/i.ts', start_line: 5, end_line: 5, signature: 'other(): void;',
        doc: '', container_id: 'iface2' },
    ];
    store.replaceFileSymbols('src/i.ts', ifaces, []);
    // The first `Dup` declares `implements Other`; the second declares nothing. Both
    // write into `src/dup.ts|Dup`, so the second would be refused by a clause it
    // never wrote.
    const nodes = [
      { id: 'd1', name: 'Dup', qname: 'Dup', kind: 'class', lang: 'ts', file: 'src/dup.ts',
        start_line: 1, end_line: 3, signature: 'export class Dup implements Other {',
        doc: '', container_id: null },
      { id: 'd1m', name: 'serialize', qname: 'Dup.serialize', kind: 'method', lang: 'ts',
        file: 'src/dup.ts', start_line: 2, end_line: 2,
        signature: 'serialize(value: unknown) { return String(value); }', doc: '',
        container_id: 'd1' },
      { id: 'd2', name: 'Dup', qname: 'Dup', kind: 'class', lang: 'ts', file: 'src/dup.ts',
        start_line: 5, end_line: 7, signature: 'export class Dup {', doc: '',
        container_id: null },
      { id: 'd2m', name: 'serialize', qname: 'Dup.serialize', kind: 'method', lang: 'ts',
        file: 'src/dup.ts', start_line: 6, end_line: 6,
        signature: 'serialize(value: unknown) { return String(value); }', doc: '',
        container_id: 'd2' },
      { id: 'fn', name: 'run', qname: 'run', kind: 'function', lang: 'ts', file: 'src/dup.ts',
        start_line: 9, end_line: 12, signature: 'export function run(a: Dup, b: Dup) {',
        doc: '', container_id: null },
    ];
    const edges = [
      { src_id: 'fn', dst_id: 'd1m', dst_name: 'serialize', kind: 'call', file: 'src/dup.ts',
        line: 10, field_key: null, method: 'serialize', dst_bare: 'serialize', lang: 'ts',
        external: 0, member: 1 },
      { src_id: 'fn', dst_id: 'd2m', dst_name: 'serialize', kind: 'call', file: 'src/dup.ts',
        line: 11, field_key: null, method: 'serialize', dst_bare: 'serialize', lang: 'ts',
        external: 0, member: 1 },
    ];
    store.replaceFileSymbols('src/dup.ts', nodes, edges, [
      { key: 'Dup#implements:Other', type: '1', file: 'src/dup.ts' },
      { key: 'src/dup.ts|Dup#implements:Other', type: '1', file: 'src/dup.ts' },
    ]);

    const rows = store.gapsFor('Serializer.serialize')
      .filter((r) => r.reason === 'implementation');
    expect(rows.map((r) => `${r.file}:${r.line}`)).toEqual(['src/dup.ts:10', 'src/dup.ts:11']);
    store.close();
  }, 30000);

  // A base class the extractor could not NAME is not a class with no base. The
  // extractor writes `<Class>#extends` only when the base is a bare name or a
  // dotted one — `extends Mix()` names no single class and guessing one would
  // invent a whole method set — so for any other expression it writes a
  // `<Class>#extendsUnknown` marker instead. Without that marker the reader saw no
  // row and read it as "extends nothing", ended the walk, and refused a row the
  // base really does carry.
  //
  // Reproduced through the real indexer: the code before this branch answered
  // `["C.serialize"]` and the reading that ends the walk answered `[]`. A mixin
  // factory is everyday TypeScript, and no clone in the study writes it, so no
  // sweep could have caught this.
  it('keeps a class whose base class the extractor could not name', async () => {
    write('src/serializer.interface.ts', `export interface Serializer {
  serialize(value: unknown): string;
}
export interface Other {
  other(): void;
}
`);
    write('src/mix.ts', `import { Serializer } from './serializer.interface';
export function Mix() {
  return class implements Serializer {
    serialize(value: unknown) { return String(value); }
  };
}
`);
    write('src/c.ts', `import { Mix } from './mix';
import { Other } from './serializer.interface';
export class C extends Mix() implements Other {
  serialize(value: unknown) { return 'c'; }
  other() { }
}
export function run(c: C) { return c.serialize(1); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['C.serialize']);
    store.close();
  }, 30000);

  // The same fact written a second way: a cast around the base name. The
  // expression is a `parenthesized_expression`, not a name, so the extractor
  // cannot name the base and says so with the marker.
  it('keeps a class whose base class is written as a cast', async () => {
    write('src/serializer.interface.ts', `export interface Serializer {
  serialize(value: unknown): string;
}
export interface Other {
  other(): void;
}
`);
    write('src/base.ts', `import { Serializer } from './serializer.interface';
export class BaseSerializer implements Serializer {
  serialize(value: unknown) { return String(value); }
}
`);
    write('src/c.ts', `import { BaseSerializer } from './base';
import { Other } from './serializer.interface';
export class C extends (BaseSerializer as any) implements Other {
  serialize(value: unknown) { return 'c'; }
  other() { }
}
export function run(c: C) { return c.serialize(1); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['C.serialize']);
    store.close();
  }, 30000);

  // A clause written on a class EXPRESSION belongs to that expression, not to the
  // class around it. `ts.scm` makes a class expression a definition only when a
  // variable declarator binds it, so `return class implements Other {}` has no
  // definition of its own and the innermost enclosing one is the outer class — the
  // clause landed there and made a class that declares NOTHING look as if it
  // declares. That bypasses the "declares nothing, keep the old rule" case and
  // refuses every true row the outer class has.
  //
  // Reproduced through the real indexer: this fixture answered `["C.serialize"]`
  // before this branch and `[]` while the clause was misattributed.
  it('keeps a class when the clause is on a class expression inside it', async () => {
    write('src/i.ts', `export interface Serializer {
  serialize(value: unknown): string;
}
export interface Other {
  other(): void;
}
`);
    write('src/c.ts', `import { Other } from './i';
export class C {
  serialize(value: unknown) { return String(value); }
  make() {
    return class implements Other {
      other() { }
    };
  }
}
export function run(c: C) { return c.serialize(1); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['C.serialize']);
    store.close();
  }, 30000);

  // The same shape as nest writes it, and the reason the repo-wide sweep could not
  // catch this: `packages/core/middleware/builder.ts:44` holds `private static
  // readonly ConfigProxy = class implements MiddlewareConfigProxy {` inside `class
  // MiddlewareBuilder implements MiddlewareConsumer`. There the stray clause only
  // ADDS to a class that already declares, so it can only keep rows. It turns
  // harmful the moment the class around it declares nothing of its own.
  it('keeps a class when a static field holds a class expression with a clause', async () => {
    write('src/i.ts', `export interface Serializer {
  serialize(value: unknown): string;
}
export interface Other {
  other(): void;
}
`);
    write('src/c.ts', `import { Other } from './i';
export class C {
  private static readonly Proxy = class implements Other {
    other() { }
  };
  serialize(value: unknown) { return String(value); }
}
export function run(c: C) { return c.serialize(1); }
`);
    const store = await indexed();

    expect(implementationVia(store, 'Serializer.serialize')).toEqual(['C.serialize']);
    store.close();
  }, 30000);
});
