import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsstatic-')); });
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

// `NestFactory.create(app)` — a call written on a CLASS, not on a value. The
// source names the owner outright, so this is as certain as a resolver gets, but
// the receiver is not a variable so nothing keyed it and the call fell through to
// a bare-name guess. Measured on nest: 1,425 such calls, of which 123 name a repo
// class that owns the method — and 121 of the 168 rows in the gap banner of
// `callers "PipesContextCreator.create"` were exactly this shape.
describe('a call written on a class name', () => {
  it('resolves to that class, not to a namesake elsewhere', async () => {
    write('src/a.ts', `export class Factory {
  static create(x: number): number { return x; }
}
export class Other {
  create(x: number): number { return x; }
}
export function boot() {
  return Factory.create(1);
}
`);
    const store = await indexed();

    expect(certain(store, 'Factory.create')).toEqual(['boot']);
    expect(store.callers('Other.create')).toEqual([]);
    store.close();
  }, 30000);

  // A variable of that name wins. `const Factory = { … }` then `Factory.create()`
  // is a call on a value, and what that value holds is not something this reader
  // can see. The old bare-name fallback may still offer a guess — that is its job
  // — but nothing here may be stated as a fact.
  it('yields to a variable that shadows the class name', async () => {
    write('src/a.ts', `export class Factory {
  static create(x: number): number { return x; }
}
export function boot() {
  const Factory = { create: (n: number) => n };
  return Factory.create(1);
}
`);
    const store = await indexed();

    expect(certain(store, 'Factory.create')).toEqual([]);
    store.close();
  }, 30000);

  it('refuses when two classes of that name exist', async () => {
    write('src/one.ts', `export class Factory {
  static create(x: number): number { return x; }
}
`);
    write('src/two.ts', `export class Factory {
  static create(x: number): number { return x; }
}
`);
    write('src/use.ts', `import { Factory } from './one';
export function boot() { return Factory.create(1); }
`);
    const store = await indexed();

    expect(store.db.prepare(
      `SELECT COUNT(*) c FROM edges WHERE dst_bare='create' AND dst_id IS NOT NULL`).get().c).toBe(0);
    store.close();
  }, 30000);

  // A class from a library names nothing this repo defines. The old bare-name
  // fallback still applies there — this pass adds a fact, it never removes one.
  it('claims nothing when the class is not in the repo', async () => {
    write('src/a.ts', `import { GqlExecutionContext } from '@nestjs/graphql';
export class Helper {
  create(x: number): number { return x; }
}
export function boot(ctx: any) {
  return GqlExecutionContext.create(ctx);
}
`);
    const store = await indexed();

    expect(certain(store, 'Helper.create')).toEqual([]);
    store.close();
  }, 30000);

  it('reaches a static method on an abstract class too', async () => {
    write('src/a.ts', `export abstract class Base {
  static make(x: number): number { return x; }
}
export function boot() { return Base.make(1); }
`);
    const store = await indexed();

    expect(certain(store, 'Base.make')).toEqual(['boot']);
    store.close();
  }, 30000);
});
