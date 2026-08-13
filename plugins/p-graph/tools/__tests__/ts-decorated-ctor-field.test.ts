import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsctor-')); });
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

const OWNERS = `export class Svc {
  run(x: number) {
    return x;
  }
}

export class Other {
  run(x: number) {
    return x;
  }
}
`;

// `constructor(private readonly svc: Svc)` declares a field and a parameter in
// one line, and it is how every NestJS class takes its dependencies. The rule
// that reads it checks for the modifier on the parameter's FIRST child — and in
// nest the first child is nearly always a decorator: `@InjectModel(Cat.name)
// private readonly catModel: Model<Cat>`. So the field row was never written,
// the type went in under the parameter's own key instead, and the call on
// `this.catModel` had nothing to match.
//
// Measured on nest: 157 such calls, and all seven rows the ⚠ banner of
// `callers "PipesContextCreator.create"` still lists are this shape.
describe('a constructor parameter property', () => {
  it('is read as a field when a decorator comes first', async () => {
    write('src/a.ts', `${OWNERS}

declare function Inject(): ParameterDecorator;

export class CatsService {
  constructor(@Inject() private readonly svc: Svc) {}

  go() {
    return this.svc.run(1);
  }
}
`);
    const store = await indexed();

    expect(store.callers('Svc.run').map((n) => n.qname)).toEqual(['CatsService.go']);
    expect(store.callers('Svc.run').every((r) => r.guess === 0)).toBe(true);
    expect(store.callers('Other.run')).toEqual([]);
    store.close();
  }, 30000);

  it('is read with a decorator that takes arguments, and a generic type', async () => {
    // The exact shape nest writes: `@InjectModel(Cat.name) private readonly
    // catModel: Model<Cat>`, where Model is a library type. Nothing resolves —
    // and that is the point: the row must be COUNTED as a library receiver, not
    // listed as a call site the reader should go and grep for.
    write('src/b.ts', `export class Cookies {
  create(x: number) {
    return x;
  }
}

export class Params {
  create(x: number) {
    return x;
  }
}

import { Model } from 'mongoose';

declare function InjectModel(name: string): ParameterDecorator;

export class CatsService {
  constructor(@InjectModel('Cat') private readonly catModel: Model<number>) {}

  make() {
    return this.catModel.create(1);
  }
}
`);
    const store = await indexed();

    expect(store.callers('Cookies.create')).toEqual([]);
    expect(store.gapsFor('Cookies.create').map((g) => g.reason)).toEqual(['library']);
    store.close();
  }, 30000);

  it('still reads an undecorated one', async () => {
    write('src/c.ts', `${OWNERS}

export class CatsService {
  constructor(private readonly svc: Svc) {}

  go() {
    return this.svc.run(1);
  }
}
`);
    const store = await indexed();

    expect(store.callers('Svc.run').map((n) => n.qname)).toEqual(['CatsService.go']);
    store.close();
  }, 30000);

  it('does not treat a plain parameter as a field', async () => {
    // No modifier means no field. `this.svc` would then be something else
    // entirely, and claiming a type for it would be invented knowledge.
    write('src/d.ts', `${OWNERS}

export class CatsService {
  constructor(svc: Svc) {}

  go() {
    return this.svc.run(1);
  }
}
`);
    const store = await indexed();

    expect(store.callers('Svc.run').filter((r) => r.guess === 0)).toEqual([]);
    store.close();
  }, 30000);
});
