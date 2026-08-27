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

// The definition used to be anchored on the interface_body around the method,
// not the method itself — the same mistake go.scm made for Go's method_spec,
// fixed the same way (see the comment above the two ts.scm rules). Anchoring
// outside was wrong twice over, both measured: an interface declaring
// `serialize`, `deserialize` and `reset` recorded ONE member, and the signature
// handed to it was `export interface Serializer {`, the interface's own
// declaration line, not the method's.
describe('a multi-method interface', () => {
  const SRC = `export interface Serializer {
  serialize(v: string): string;
  deserialize(v: string): string;
  reset(): void;
}
`;

  it('records every method the interface declares, not only the first', async () => {
    write('src/a.ts', SRC);
    const store = await indexed();

    const members = store.db.prepare(
      `SELECT n.name FROM nodes n JOIN nodes o ON n.container_id = o.id
       WHERE o.name = 'Serializer' ORDER BY n.name`).all().map((r) => r.name);
    expect(members).toEqual(['deserialize', 'reset', 'serialize']);
    store.close();
  }, 30000);

  it('gives each one its own line and its own signature', async () => {
    write('src/a.ts', SRC);
    const store = await indexed();

    expect(store.node('Serializer.serialize').start_line).toBe(2);
    expect(store.node('Serializer.deserialize').start_line).toBe(3);
    expect(store.node('Serializer.reset').start_line).toBe(4);
    expect(store.node('Serializer.serialize').signature).toBe('serialize(v: string): string;');
    expect(store.node('Serializer.deserialize').signature).toBe('deserialize(v: string): string;');
    // The interface's own line must no longer be handed to every method on it.
    expect(store.node('Serializer.reset').signature).not.toContain('interface {');
    store.close();
  }, 30000);

  // The function-typed-property shape (`handle: (x) => void`) is a second query
  // rule and was anchored the same wrong way. It needs the same proof.
  it('gives the function-typed-property shape its own line too', async () => {
    write('src/a.ts', `export interface Hooks {
  before: () => void;
  after: () => void;
}
`);
    const store = await indexed();

    expect(store.node('Hooks.before').start_line).toBe(2);
    expect(store.node('Hooks.after').start_line).toBe(3);
    expect(store.node('Hooks.before').signature).toBe('before: () => void;');
    expect(store.node('Hooks.after').signature).toBe('after: () => void;');
    store.close();
  }, 30000);
});
