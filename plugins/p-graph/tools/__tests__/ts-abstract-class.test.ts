import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsabs-')); });
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

// `abstract class` is its own node type in this grammar (abstract_class_declaration),
// and the query only matched `class_declaration`. So an abstract class and every
// method in it were missing from the graph completely. Measured on nest: ClientProxy,
// Server and ContextCreator — the base classes the whole framework hangs off — had
// zero nodes and zero methods.
describe('an abstract class', () => {
  it('is a node like any other class', async () => {
    write('src/a.ts', `export abstract class Base {
  protected run(): void {}
}
`);
    const store = await indexed();

    expect(store.db.prepare(
      `SELECT kind, qname FROM nodes WHERE lang='ts' AND name='Base'`).all())
      .toEqual([{ kind: 'class', qname: 'Base' }]);
    store.close();
  }, 30000);

  it('owns its methods, so a member call can reach them', async () => {
    write('src/a.ts', `export abstract class Base {
  protected run(): void {}
  public start(): void { this.run(); }
}
`);
    const store = await indexed();

    expect(certain(store, 'Base.run')).toEqual(['Base.start']);
    store.close();
  }, 30000);

  it('is still one node when it is exported', async () => {
    write('src/a.ts', `export abstract class Base {}
`);
    const store = await indexed();

    expect(store.db.prepare(
      `SELECT COUNT(*) c FROM nodes WHERE lang='ts' AND name='Base'`).get().c).toBe(1);
    store.close();
  }, 30000);
});
