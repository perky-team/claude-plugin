import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsglobal-')); });
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

// `Object.assign(…)`, `JSON.parse(…)`, `Reflect.getMetadata(…)` name the JavaScript
// language, never this repo. Go has had this list since the start (GO_BUILTINS);
// TypeScript had none, so two things went wrong at once. The bare-name fallback
// answered `JSON.parse` with a repo method called `parse` — 71 such guesses in nest
// and 61 for `assign` — and every unmatched one turned up in the gap banner of
// whatever repo method shares the name: 126 `Object.create` and `Array.create`
// rows sat in the banner of `callers "PipesContextCreator.create"`.
describe('a call on a JavaScript global', () => {
  it('does not become a caller of a repo method that shares the name', async () => {
    write('src/a.ts', `export class Opts {
  assign(a: number): number { return a; }
}
export function merge(a: object, b: object) {
  return Object.assign(a, b);
}
`);
    const store = await indexed();

    expect(store.callers('Opts.assign')).toEqual([]);
    store.close();
  }, 30000);

  // Two repo classes carry `parse`, so the bare-name fallback cannot claim the
  // call and it stays unresolved — which is exactly when a row reaches the gap
  // banner. It must not: `JSON.parse` is settled, not missing.
  it('is not reported as a gap', async () => {
    write('src/a.ts', `export class Codec {
  parse(s: string): unknown { return s; }
}
export class OtherCodec {
  parse(s: string): unknown { return s; }
}
export function read(s: string) {
  return JSON.parse(s);
}
`);
    const store = await indexed();

    // `external` and `library` are the two reasons the CLI drops from the ⚠ banner,
    // so that is the claim to make here: the row is settled, not a missing call
    // site. `JSON` is a global, so the receiver's type is a library one.
    const settled = new Set(['external', 'library']);
    expect(store.gapsFor('Codec.parse').filter((g) => !settled.has(g.reason))).toEqual([]);
    store.close();
  }, 30000);

  // The repo's own class wins, the same way a Go package that declares `max`
  // shadows the builtin. Otherwise this list would delete real answers.
  it('yields to a repo class of the same name', async () => {
    write('src/a.ts', `export class Reflect {
  static getMetadata(k: string): string { return k; }
}
export function read() {
  return Reflect.getMetadata('k');
}
`);
    const store = await indexed();

    expect(store.callers('Reflect.getMetadata').filter((r) => !r.guess).map((r) => r.qname))
      .toEqual(['read']);
    store.close();
  }, 30000);

  // A local of that name is a value, not the global, so nothing here applies.
  it('leaves a local variable of that name alone', async () => {
    write('src/a.ts', `export class Codec {
  parse(s: string): unknown { return s; }
}
export function read(s: string) {
  const JSON = new Codec();
  return JSON.parse(s);
}
`);
    const store = await indexed();

    expect(store.callers('Codec.parse').filter((r) => !r.guess).map((r) => r.qname))
      .toEqual(['read']);
    store.close();
  }, 30000);
});
