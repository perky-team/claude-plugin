import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsmodconst-')); });
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

// `export const NestFactory = new NestFactoryStatic();` — one file declares the
// value, every other file imports the NAME and calls methods on it. The receiver is
// not a local, and no class is called NestFactory, so there was nothing to resolve
// through. Measured on nest: `NestFactory.create(…)` alone was 50 of the 100 rows
// still left in the gap banner of `callers "PipesContextCreator.create"`.
describe('a value declared at the top of a module', () => {
  it('types a call made on its name in another file', async () => {
    write('src/factory.ts', `export class FactoryStatic {
  create(x: number): number { return x; }
}
export const Factory = new FactoryStatic();
`);
    write('src/main.ts', `import { Factory } from './factory';
export function boot() { return Factory.create(1); }
`);
    const store = await indexed();

    expect(certain(store, 'FactoryStatic.create')).toEqual(['boot']);
    store.close();
  }, 30000);

  it('reads a written type as readily as a `new`', async () => {
    write('src/log.ts', `export class Logger {
  log(m: string): void {}
}
declare function build(): Logger;
export const logger: Logger = build();
`);
    write('src/main.ts', `import { logger } from './log';
export function boot() { logger.log('x'); }
`);
    const store = await indexed();

    expect(certain(store, 'Logger.log')).toEqual(['boot']);
    store.close();
  }, 30000);

  it('refuses when two modules bind the same name to different types', async () => {
    write('src/one.ts', `export class A { go(): void {} }
export const dep = new A();
`);
    write('src/two.ts', `export class B { go(): void {} }
export const dep = new B();
`);
    write('src/main.ts', `import { dep } from './one';
export function boot() { dep.go(); }
`);
    const store = await indexed();

    expect(certain(store, 'A.go')).toEqual([]);
    expect(certain(store, 'B.go')).toEqual([]);
    store.close();
  }, 30000);

  // A name declared INSIDE a function is not visible to another file, so it must
  // not be offered as a repo-wide fact.
  it('ignores a binding that is local to a function', async () => {
    write('src/one.ts', `export class A { go(): void {} }
export function make() {
  const dep = new A();
  dep.go();
}
`);
    // `dep` here is a different thing entirely — a parameter of unknown type. The
    // local in one.ts must not type it.
    write('src/two.ts', `export function boot(dep) { dep.go(); }
`);
    const store = await indexed();

    expect(certain(store, 'A.go')).toEqual(['make']);
    store.close();
  }, 30000);
});
