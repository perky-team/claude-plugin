import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsfield-')); });
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
const certain = (store, qname) => store.callers(qname).filter((r) => !r.guess).map((r) => r.qname);

// `this.<field>.<method>()` is the shape TypeScript writes most, and the shape
// p-graph could not read at all: the receiver is a member expression, not a name,
// so no key was built and the call stayed unresolved. Measured on nest: 1,019 such
// calls, none of them resolved, and every one of the 20 false rows in the gap
// banner of `callers "ClassSerializerInterceptor.serialize"` was one of them.
describe('a call on a class field', () => {
  it('resolves through the type written on the field', async () => {
    write('src/a.ts', `export class Serializer {
  serialize(v: string): string { return v; }
}
export class Client {
  private readonly ser: Serializer;
  run() { return this.ser.serialize('x'); }
}
`);
    const store = await indexed();

    expect(certain(store, 'Serializer.serialize')).toEqual(['Client.run']);
    store.close();
  }, 30000);

  // `constructor(private readonly svc: Svc)` declares a field and a parameter in
  // one line. It is how every NestJS class takes its dependencies, so a reader
  // that misses it misses the framework's whole calling pattern.
  it('resolves through a constructor parameter property', async () => {
    write('src/a.ts', `export class Svc {
  find(id: number): number { return id; }
}
export class Ctrl {
  constructor(private readonly svc: Svc) {}
  get(id: number) { return this.svc.find(id); }
}
`);
    const store = await indexed();

    expect(certain(store, 'Svc.find')).toEqual(['Ctrl.get']);
    store.close();
  }, 30000);

  it('reads the type from a `new` initialiser when none is written', async () => {
    write('src/a.ts', `export class Svc {
  find(id: number): number { return id; }
}
export class Ctrl {
  private svc = new Svc();
  get(id: number) { return this.svc.find(id); }
}
`);
    const store = await indexed();

    expect(certain(store, 'Svc.find')).toEqual(['Ctrl.get']);
    store.close();
  }, 30000);

  // The field is declared on a base class in ANOTHER file and used in the
  // subclass. This is the exact shape of nest's `this.serializer.serialize(…)`:
  // `serializer` is declared on ClientProxy, and every call is in a subclass.
  it('finds a field declared on a base class in another file', async () => {
    write('src/base.ts', `import { Serializer } from './ser';
export abstract class ClientProxy {
  protected serializer: Serializer;
}
`);
    write('src/ser.ts', `export class Serializer {
  serialize(v: string): string { return v; }
}
`);
    write('src/kafka.ts', `import { ClientProxy } from './base';
export class ClientKafka extends ClientProxy {
  publish(v: string) { return this.serializer.serialize(v); }
}
`);
    const store = await indexed();

    expect(certain(store, 'Serializer.serialize')).toEqual(['ClientKafka.publish']);
    store.close();
  }, 30000);

  it('follows the extends chain more than one step', async () => {
    write('src/a.ts', `export class Serializer {
  serialize(v: string): string { return v; }
}
export abstract class Root {
  protected ser: Serializer;
}
export abstract class Middle extends Root {}
export class Leaf extends Middle {
  run(v: string) { return this.ser.serialize(v); }
}
`);
    const store = await indexed();

    expect(certain(store, 'Serializer.serialize')).toEqual(['Leaf.run']);
    store.close();
  }, 30000);

  // `protected serializer: ProducerSerializer` where
  // `type ProducerSerializer = Serializer<…>`. No class is called
  // ProducerSerializer, so without following the alias the receiver has no type.
  it('follows a type alias to the type it names', async () => {
    write('src/a.ts', `export interface Serializer {
  serialize(v: string): string;
}
export type ProducerSerializer = Serializer;
export class Client {
  protected ser: ProducerSerializer;
  run() { return this.ser.serialize('x'); }
}
`);
    const store = await indexed();

    expect(certain(store, 'Serializer.serialize')).toEqual(['Client.run']);
    store.close();
  }, 30000);

  it('drops the type arguments of a generic alias', async () => {
    write('src/a.ts', `export interface Serializer<T> {
  serialize(v: T): T;
}
export type ProducerSerializer = Serializer<number>;
export class Client {
  protected ser: ProducerSerializer;
  run() { return this.ser.serialize(1); }
}
`);
    const store = await indexed();

    expect(certain(store, 'Serializer.serialize')).toEqual(['Client.run']);
    store.close();
  }, 30000);
});

// The same guard C++ needed, for the same reason: nest ships three sample apps
// that each declare a `RecipesService`, and keying a field on the class's bare
// name alone would collect three types under one key and answer none of them.
describe('two classes of one name in different files', () => {
  it('each file uses the field type its own class declares', async () => {
    write('src/one.ts', `export class A {
  go(): void {}
}
export class Holder {
  private dep: A;
  run() { this.dep.go(); }
}
`);
    write('src/two.ts', `export class B {
  go(): void {}
}
export class Holder {
  private dep: B;
  run() { this.dep.go(); }
}
`);
    const store = await indexed();

    expect(certain(store, 'A.go')).toEqual(['Holder.run']);
    expect(certain(store, 'B.go')).toEqual(['Holder.run']);
    store.close();
  }, 30000);
});

describe('a field whose type leads nowhere', () => {
  // The type is written but it belongs to a library. The old behaviour was to
  // fall back to the one repo method that shares the bare name; that is a guess
  // the source does not support, so nothing is claimed.
  it('claims nothing when the type is not a repo type', async () => {
    write('src/a.ts', `import { Redis } from 'ioredis';
export class Helper {
  set(k: string): void {}
}
export class Client {
  private client: Redis;
  run() { this.client.set('k'); }
}
`);
    const store = await indexed();

    expect(store.callers('Helper.set')).toEqual([]);
    store.close();
  }, 30000);

  it('claims nothing when the repo type has no such method', async () => {
    write('src/a.ts', `export class Store {
  get(k: string): string { return k; }
}
export class Other {
  put(k: string): void {}
}
export class Client {
  private store: Store;
  run() { this.store.put('k'); }
}
`);
    const store = await indexed();

    expect(store.callers('Other.put')).toEqual([]);
    store.close();
  }, 30000);
});
