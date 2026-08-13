import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsret-')); });
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

// Go has read a function's declared result since the start, and Python since
// the round before this one. TypeScript — the language that writes a return
// type more often than either — read none: all three TypeScript graphs in the
// study held ZERO "#ret" rows.
describe('a TypeScript return type', () => {
  it('types a value the call produced', async () => {
    write('src/a.ts', `${OWNERS}

export function make(): Svc {
  return new Svc();
}

export function go() {
  const s = make();
  return s.run(1);
}
`);
    const store = await indexed();

    expect(store.callers('Svc.run').map((n) => n.qname)).toEqual(['go']);
    expect(store.callers('Svc.run').every((r) => r.guess === 0)).toBe(true);
    expect(store.callers('Other.run')).toEqual([]);
    store.close();
  }, 30000);

  it('reads through Promise on an async function', async () => {
    // An async function is annotated `Promise<Svc>`, and the value everyone
    // uses is the awaited one. A Promise's own methods are `then` and `catch`,
    // which no repo class answers, so unwrapping cannot cost a real row.
    write('src/a.ts', `${OWNERS}

export async function make(): Promise<Svc> {
  return new Svc();
}

export async function go() {
  const s = await make();
  return s.run(1);
}
`);
    const store = await indexed();

    expect(store.callers('Svc.run').map((n) => n.qname)).toEqual(['go']);
    store.close();
  }, 30000);

  it('reads it from a method too', async () => {
    write('src/a.ts', `${OWNERS}

export class Factory {
  build(): Svc {
    return new Svc();
  }

  go() {
    const s = this.build();
    return s.run(1);
  }
}
`);
    const store = await indexed();

    expect(store.callers('Svc.run').map((n) => n.qname)).toEqual(['Factory.go']);
    store.close();
  }, 30000);

  it('refuses the guess when the callee returns something outside the repo', async () => {
    // One repo class owns `run`, so today the bare name answers this. The
    // source says the value is a Duplex, so that answer is wrong.
    write('src/a.ts', `import { Duplex } from 'node:stream';

export class Svc {
  run(x: number) {
    return x;
  }
}

export function open(): Duplex {
  return null as any;
}

export function go() {
  const s = open();
  return s.run(1);
}
`);
    const store = await indexed();

    expect(store.callers('Svc.run')).toEqual([]);
    store.close();
  }, 30000);

  it('leaves an unannotated callee exactly as it was', async () => {
    write('src/a.ts', `export class Svc {
  run(x: number) {
    return x;
  }
}

export function make() {
  return new Svc();
}

export function go() {
  const s = make();
  return s.run(1);
}
`);
    const store = await indexed();

    const rows = store.callers('Svc.run');
    expect(rows.map((n) => n.qname)).toEqual(['go']);
    expect(rows.every((r) => r.guess === 1)).toBe(true);
    store.close();
  }, 30000);

  it('does not read a union or an inline object as one type', async () => {
    write('src/a.ts', `${OWNERS}

export function make(): Svc | undefined {
  return new Svc();
}

export function go() {
  const s = make();
  return s.run(1);
}
`);
    const store = await indexed();

    expect(store.callers('Svc.run').filter((r) => r.guess === 0)).toEqual([]);
    store.close();
  }, 30000);
});
