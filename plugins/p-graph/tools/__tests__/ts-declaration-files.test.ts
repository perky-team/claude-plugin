import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsdecl-')); });
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

// A published `index.d.ts` restates the API of the code beside it, under names of
// its own. axios ships two of them, `index.d.ts` and `index.d.cts`, and between
// them they declare `AxiosInterceptorManager.eject` twice for the one
// `InterceptorManager.eject` in `lib/`. Counted as definitions, those twins make
// 18 bare names in axios ambiguous and nothing else does. A header already yields
// to its definition in C++; this is the same rule for the same reason.
//
// The fixture below is an `interface`, matching how axios itself declares
// `AxiosInterceptorManager` — not a `declare class`. An ambient class method
// with no body parses as `method_signature` inside `class_body`, a shape the
// TypeScript query file does not capture at all (only `interface_body
// method_signature` is captured), so it never becomes a node regardless of
// this task's change. That gap is a separate, pre-existing hole in extraction,
// not something this task's decl marking can or should paper over.
describe('a TypeScript declaration file is marked as declarations', () => {
  it('marks every node from a .d.ts file', async () => {
    write('index.d.ts', `export interface ApiInterceptor {
  eject(id: number): void;
}
`);
    const store = await indexed();

    const eject = store.symbolsNamed('eject').filter((n) => n.file === 'index.d.ts');
    expect(eject).toHaveLength(1);
    expect(eject[0].decl).toBe(1);
    store.close();
  }, 30000);

  it('marks .d.cts and .d.mts the same way', async () => {
    write('index.d.cts', `export interface ApiInterceptor { eject(id: number): void; }\n`);
    write('index.d.mts', `export interface ApiInterceptor { eject(id: number): void; }\n`);
    const store = await indexed();

    for (const f of ['index.d.cts', 'index.d.mts']) {
      const n = store.symbolsNamed('eject').filter((x) => x.file === f);
      expect(n, f).toHaveLength(1);
      expect(n[0].decl, f).toBe(1);
    }
    store.close();
  }, 30000);

  // The guard is on the whole suffix, not on a bare `.d`. `schema.d.ts` is a
  // declaration; `payload.ts` beside it is not. Both files are here on purpose: a
  // repo holding only `payload.ts` would pass this case even if the suffix rule
  // were never applied at all.
  it('leaves an ordinary .ts file alone', async () => {
    write('lib/schema.d.ts', `export interface Schema {
  send(x: number): void;
}
`);
    write('lib/payload.ts', `export class Payload {
  wrap(x: number): void {}
}
`);
    const store = await indexed();

    const wrap = store.symbolsNamed('wrap').filter((n) => n.file === 'lib/payload.ts');
    expect(wrap).toHaveLength(1);
    expect(wrap[0].decl).toBe(0);
    const send = store.symbolsNamed('send').filter((n) => n.file === 'lib/schema.d.ts');
    expect(send).toHaveLength(1);
    expect(send[0].decl).toBe(1);
    store.close();
  }, 30000);

  // The language resolver lowercases the extension before it picks TypeScript
  // (parse/index.mjs), so `Index.D.TS` is indexed as TypeScript. The suffix test
  // has to read the name the same way, or the file is parsed as code that defines
  // an API and its nodes compete with the real ones.
  it('marks a declaration file whose name is uppercase', async () => {
    write('Index.D.TS', `export interface Api {
  send(x: number): void;
}
`);
    const store = await indexed();

    const send = store.symbolsNamed('send').filter((n) => n.file === 'Index.D.TS');
    expect(send).toHaveLength(1);
    expect(send[0].decl).toBe(1);
    store.close();
  }, 30000);
});
