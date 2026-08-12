import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsiface-')); });
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

// An interface is TypeScript's main way of naming a set of methods, and a call
// written through one is everyday code. The graph had the interface node but none
// of its members, so `pgraph callers "Serializer.serialize"` answered "no symbol
// named Serializer.serialize" — measured on nest, 312 interfaces and 0 members.
describe('a method declared on an interface', () => {
  it('is a node owned by the interface', async () => {
    write('src/a.ts', `export interface Serializer {
  serialize(value: string): string;
}
`);
    const store = await indexed();

    const rows = store.db.prepare(
      `SELECT n.kind, n.qname, o.name owner FROM nodes n JOIN nodes o ON n.container_id = o.id
       WHERE n.lang='ts' AND n.name='serialize'`).all();
    expect(rows).toEqual([{ kind: 'method', qname: 'Serializer.serialize', owner: 'Serializer' }]);
    store.close();
  }, 30000);

  // `handle: (x: number) => void` declares a method just as much as
  // `handle(x: number): void` does. A property that holds anything else does not.
  it('counts a property whose type is a function', async () => {
    write('src/a.ts', `export interface Hooks {
  handle: (x: number) => void;
  name: string;
}
`);
    const store = await indexed();

    expect(store.db.prepare(
      `SELECT name FROM nodes WHERE lang='ts' AND container_id IS NOT NULL ORDER BY name`).all())
      .toEqual([{ name: 'handle' }]);
    store.close();
  }, 30000);

  // The point of indexing them: a call written on a value of that interface type
  // now has somewhere to land.
  it('can be the target of a call through a typed parameter', async () => {
    write('src/a.ts', `export interface Serializer {
  serialize(value: string): string;
}
export function run(s: Serializer) {
  return s.serialize('x');
}
`);
    const store = await indexed();

    expect(store.callers('Serializer.serialize').filter((r) => !r.guess).map((r) => r.qname))
      .toEqual(['run']);
    store.close();
  }, 30000);

  // A declaration is not a call. `serialize(value: string): string;` inside the
  // interface must not look like a call to itself.
  it('does not call itself', async () => {
    write('src/a.ts', `export interface Serializer {
  serialize(value: string): string;
}
`);
    const store = await indexed();

    expect(store.callers('Serializer.serialize')).toEqual([]);
    store.close();
  }, 30000);
});
