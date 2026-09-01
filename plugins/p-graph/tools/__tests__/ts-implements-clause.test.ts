import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsimpl-')); });
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

// One `<Class>#implements:<Iface>` row per pair — the key carries the fact, the
// value is a marker. This reads every such row for one class and returns the
// interface names, so a test can assert on the set without caring which of the
// two keys (class-wide or file-scoped) it came from.
const implementsOf = (store, cls) => {
  const prefix = `${cls}#implements:`;
  return store.db.prepare('SELECT key FROM field_types WHERE key LIKE ?')
    .all(`${prefix}%`)
    .map((r) => r.key.slice(prefix.length));
};

const extendsOf = (store, cls) =>
  store.db.prepare('SELECT type FROM field_types WHERE key = ?').get(`${cls}#extends`)?.type ?? null;

describe('a class records what it says it implements', () => {
  it('records a plain implements clause', async () => {
    write('lib/a.ts', `export interface Serializer { serialize(v: unknown): string; }
export class A implements Serializer {
  serialize(v: unknown) { return ''; }
}
`);
    const store = await indexed();
    expect(implementsOf(store, 'A')).toEqual(['Serializer']);
    store.close();
  }, 30000);

  it('records every interface in a list', async () => {
    // A class implementing two interfaces must not cancel itself out. Every reader of
    // field_types folds a key to one value and poisons it when two rows disagree, so
    // the interface name lives in the KEY, one row per pair.
    write('lib/b.ts', `export class B implements NestInterceptor, OnModuleInit {
  serialize(v: unknown) { return ''; }
}
`);
    const store = await indexed();
    expect(implementsOf(store, 'B').sort()).toEqual(['NestInterceptor', 'OnModuleInit']);
    store.close();
  }, 30000);

  it('strips the type arguments', async () => {
    write('lib/c.ts', `export class C implements Serializer<X, Y> {
  serialize(v: unknown) { return ''; }
}
`);
    const store = await indexed();
    expect(implementsOf(store, 'C')).toEqual(['Serializer']);
    store.close();
  }, 30000);

  it('keeps only the last segment of a nested name', async () => {
    write('lib/d.ts', `export class D implements ns.Outer.Iface {
  serialize(v: unknown) { return ''; }
}
`);
    const store = await indexed();
    expect(implementsOf(store, 'D')).toEqual(['Iface']);
    store.close();
  }, 30000);

  it('records nothing for a class that declares nothing', async () => {
    write('lib/e.ts', `export class E {
  serialize(v: unknown) { return ''; }
}
`);
    const store = await indexed();
    expect(implementsOf(store, 'E')).toEqual([]);
    store.close();
  }, 30000);

  // `extends` and `implements` sit in the same class_heritage node. Reading one must
  // not disturb the other — `#extends` is what the field-type resolver walks to find
  // a field declared on a base class.
  it('leaves the extends row alone', async () => {
    write('lib/f.ts', `export class F extends Base implements Serializer {
  serialize(v: unknown) { return ''; }
}
`);
    const store = await indexed();
    expect(implementsOf(store, 'F')).toEqual(['Serializer']);
    expect(extendsOf(store, 'F')).toBe('Base');
    store.close();
  }, 30000);
});
