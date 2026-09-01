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

// Each pair is written twice, under a class-wide key and a file-scoped one, the
// same as `#field:` and `#extends`. The key carries the fact and the value is only
// a marker.
//
// This reads the CLASS-WIDE key alone. The `LIKE` pattern has no leading wildcard,
// so it cannot match `<file>|<Class>#implements:<Iface>` — that row has its own
// helper and its own case below. An earlier version of this comment claimed the
// helper covered both keys; it never could, and nothing asserted the twin.
const implementsOf = (store, cls) => {
  const prefix = `${cls}#implements:`;
  return store.db.prepare('SELECT key FROM field_types WHERE key LIKE ?')
    .all(`${prefix}%`)
    .map((r) => r.key.slice(prefix.length));
};

// The file-scoped twin. `resolveTsFieldTypes` prefers a file's own declaration over
// the class-wide one, so a repo with two classes of the same name needs this key to
// tell them apart. Without a test on it, dropping it would pass the whole suite.
const implementsFileScoped = (store, file, cls) => {
  const prefix = `${file}|${cls}#implements:`;
  return store.db.prepare('SELECT key FROM field_types WHERE key LIKE ?')
    .all(`${prefix}%`)
    .map((r) => r.key.slice(prefix.length));
};

const extendsOf = (store, cls) =>
  store.db.prepare('SELECT type FROM field_types WHERE key = ?').get(`${cls}#extends`)?.type ?? null;

// "There IS a base class and the extractor could not name it." A different fact
// from "there is no extends clause", and the reader has to tell them apart: the
// second one ends the base-class walk, the first one must stop the walk from
// deciding anything.
const extendsUnknownOf = (store, cls) => store.db
  .prepare('SELECT type FROM field_types WHERE key = ?').get(`${cls}#extendsUnknown`)?.type ?? null;

const extendsUnknownFileScoped = (store, file, cls) => store.db
  .prepare('SELECT type FROM field_types WHERE key = ?')
  .get(`${file}|${cls}#extendsUnknown`)?.type ?? null;

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

  it('writes the file-scoped twin as well as the class-wide key', async () => {
    // Two rows per pair, not one. Two classes of one name in a repo share the
    // class-wide key, so the file-scoped one is what tells them apart — the same
    // reason `#field:` and `#extends` are written twice.
    write('lib/a.ts', `export interface Serializer { serialize(v: unknown): string; }
export class A implements Serializer {
  serialize(v: unknown) { return ''; }
}
`);
    const store = await indexed();

    expect(implementsFileScoped(store, 'lib/a.ts', 'A')).toEqual(['Serializer']);
    expect(store.db.prepare('SELECT type FROM field_types WHERE key = ?')
      .get('lib/a.ts|A#implements:Serializer')?.type).toBe('1');
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

  // A base the extractor cannot name gets a marker row, so the reader can tell
  // "there is a base I could not read" from "there is no extends clause". Reading
  // the second where the first is true ends the base-class walk early and refuses
  // a row the base really does carry — measured through the real indexer, a mixin
  // base turned `["C.serialize"]` into `[]`.
  it('records that a base class could not be named', async () => {
    write('lib/g.ts', `export class G extends Mix() implements Serializer {
  serialize(v: unknown) { return ''; }
}
`);
    const store = await indexed();

    expect(extendsOf(store, 'G')).toBe(null);
    expect(extendsUnknownOf(store, 'G')).toBe('1');
    expect(extendsUnknownFileScoped(store, 'lib/g.ts', 'G')).toBe('1');
    expect(implementsOf(store, 'G')).toEqual(['Serializer']);
    store.close();
  }, 30000);

  it('records that a base class written as a cast could not be named', async () => {
    write('lib/h.ts', `export class H extends (Base as any) {
  serialize(v: unknown) { return ''; }
}
`);
    const store = await indexed();

    expect(extendsOf(store, 'H')).toBe(null);
    expect(extendsUnknownOf(store, 'H')).toBe('1');
    store.close();
  }, 30000);

  // A base name the extractor CAN read gets no marker. The marker means "a base is
  // there and I could not name it", so a class that names its base must not carry
  // one — otherwise the walk would refuse to read a chain it can read perfectly.
  it('records no marker when the base class has a plain name', async () => {
    write('lib/i.ts', `export class I extends Base implements Serializer {
  serialize(v: unknown) { return ''; }
}
export class J extends ns.Outer.Base { }
export class K { }
`);
    const store = await indexed();

    expect(extendsUnknownOf(store, 'I')).toBe(null);
    expect(extendsOf(store, 'I')).toBe('Base');
    expect(extendsUnknownOf(store, 'J')).toBe(null);
    expect(extendsOf(store, 'J')).toBe('Base');
    expect(extendsUnknownOf(store, 'K')).toBe(null);
    store.close();
  }, 30000);

  // `extends new Foo().Bar` is a `member_expression` too, and its `property` is
  // `Bar` — a name the source never wrote as a base class. Naming it would send
  // the walk to whatever class in the repo happens to be called `Bar` and let it
  // refuse rows on that class's clause, so the base counts as unnameable.
  it('records that a computed base class could not be named', async () => {
    write('lib/l.ts', `export class L extends new Foo().Bar { }
`);
    const store = await indexed();

    expect(extendsOf(store, 'L')).toBe(null);
    expect(extendsUnknownOf(store, 'L')).toBe('1');
    store.close();
  }, 30000);

  // A clause on an unbound class expression is not the enclosing class's clause.
  // `ts.scm` makes a class expression a definition only when a variable declarator
  // binds it, so this one has no definition and the innermost enclosing one is the
  // class around it. Writing the clause there made a class that declares nothing
  // look as if it declares, and the reader then refused every true row it had.
  it('does not put a clause from an unbound class expression on the class around it', async () => {
    write('lib/m.ts', `export class M {
  serialize(v: unknown) { return ''; }
  make() { return class implements Other { other() { } }; }
  static readonly Proxy = class implements Second { second() { } };
}
`);
    const store = await indexed();

    expect(implementsOf(store, 'M')).toEqual([]);
    expect(implementsFileScoped(store, 'lib/m.ts', 'M')).toEqual([]);
    store.close();
  }, 30000);

  // The bound one still counts. `const W = class implements Serializer {}` IS a
  // definition — ts.scm anchors it on the declarator — so its clause is its own and
  // must keep being recorded under the name the declarator gives it.
  it('records the clause of a class expression bound to a name', async () => {
    write('lib/n.ts', `export const W = class implements Serializer {
  serialize(v: unknown) { return ''; }
};
`);
    const store = await indexed();

    expect(implementsOf(store, 'W')).toEqual(['Serializer']);
    expect(implementsFileScoped(store, 'lib/n.ts', 'W')).toEqual(['Serializer']);
    store.close();
  }, 30000);

  // The same rule for the base class. `return class extends Base {}` used to record
  // `Base` as the ENCLOSING class's base, which sent the base-chain walk into a
  // class the outer one never extends, and an unnameable base there would have
  // silenced the whole check for the outer class.
  it('does not put a base class from an unbound class expression on the class around it', async () => {
    write('lib/o.ts', `export class O {
  serialize(v: unknown) { return ''; }
  make() { return class extends Base { }; }
  other() { return class extends Mix() { }; }
}
`);
    const store = await indexed();

    expect(extendsOf(store, 'O')).toBe(null);
    expect(extendsUnknownOf(store, 'O')).toBe(null);
    store.close();
  }, 30000);
});
