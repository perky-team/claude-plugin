import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsimport-')); });
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

const RUNNER = `export class Runner {
  create(x: number) {
    return x;
  }
}
`;

// A call written on a plain name that no local binds is keyed "#static:<name>",
// and when no repo class carries the name the bare-name fallback answers it with
// whatever single repo symbol shares the method name. But the name is often an
// IMPORT — `Test.createTestingModule(...)` is @nestjs/testing's Test — and an
// imported value is not this repo's, which the import statement says outright.
// Measured: 264 such guessed calls in nest, 13 in axios, 1 in got.
describe('a call written on an imported name', () => {
  it('is not guessed at a repo symbol that shares the method name', async () => {
    write('src/runner.ts', RUNNER);
    write('src/a.spec.ts', `import { Test } from '@nestjs/testing';

export function build() {
  return Test.create(1);
}
`);
    const store = await indexed();

    expect(store.callers('Runner.create')).toEqual([]);
    const gaps = store.gapsFrom('build');
    expect(gaps.map((g) => `${g.dst_name}:${g.reason}`)).toEqual(['create:external']);
    store.close();
  }, 30000);

  it('handles a default import and a namespace import', async () => {
    write('src/runner.ts', RUNNER);
    write('src/b.ts', `import chai from 'chai';
import * as https from 'node:https';

export function go() {
  chai.create(1);
  https.create(2);
}
`);
    const store = await indexed();

    expect(store.callers('Runner.create')).toEqual([]);
    store.close();
  }, 30000);

  it('follows the alias, not the original name', async () => {
    write('src/runner.ts', RUNNER);
    write('src/c.ts', `import { Thing as Test } from 'somewhere';

export function go() {
  Test.create(1);
}
`);
    const store = await indexed();

    expect(store.callers('Runner.create')).toEqual([]);
    store.close();
  }, 30000);

  it('still resolves when the repo declares a class of that name', async () => {
    // The mark is a fact about this file's imports, not about the language. A
    // repo class of the same name wins, exactly as a Go package that declares
    // its own `max` wins over the builtin.
    write('src/test.ts', `export class Test {
  create(x: number) {
    return x;
  }
}
`);
    write('src/d.ts', `import { Test } from './test';

export function go() {
  return Test.create(1);
}
`);
    const store = await indexed();

    expect(store.callers('Test.create').map((n) => n.qname)).toEqual(['go']);
    expect(store.callers('Test.create').every((r) => r.guess === 0)).toBe(true);
    store.close();
  }, 30000);

  it('leaves a locally bound name alone', async () => {
    // `const Test = …` in this file is not an import, and the old behaviour has
    // to stand for it.
    write('src/runner.ts', RUNNER);
    write('src/e.ts', `export function go(Test: any) {
  return Test.create(1);
}
`);
    const store = await indexed();

    const rows = store.callers('Runner.create');
    expect(rows.map((n) => n.qname)).toEqual(['go']);
    expect(rows.every((r) => r.guess === 1)).toBe(true);
    store.close();
  }, 30000);
});
