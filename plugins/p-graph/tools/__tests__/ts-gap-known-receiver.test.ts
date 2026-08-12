import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsgapowner-')); });
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
const listed = (store, name) =>
  store.gapsFor(name).filter((g) => g.reason !== 'external').map((g) => `${g.file}:${g.line}`);

// The gap banner matches on the bare name alone, so a common method name filled it
// with calls that belong to something else. Measured on nest: `callers
// "PipesContextCreator.create"` found all four of its call sites and then printed
// 168 other `create` calls and told the reader to go and grep — which is the whole
// cost the graph exists to remove.
//
// A row can be ruled out honestly whenever the source itself says which type the
// call was made on. That is not a guess about the call: it is the type written on
// the declaration, the same fact the resolver uses.
//
// Each fixture below declares the receiver's class TWICE, which is what makes the
// call unresolved (the resolver refuses two candidates) while the written type name
// is still perfectly clear. That is nest's own shape — six classes called
// CatsService across its sample apps.
describe('the gap report and a receiver whose type is written down', () => {
  const twoWidgets = () => {
    write('src/w1.ts', `export class Widget {
  create(x: number): number { return x; }
}
`);
    write('src/w2.ts', `export class Widget {
  create(x: number): number { return x; }
}
`);
  };

  it('leaves out a call whose receiver is a different type', async () => {
    write('src/pipes.ts', `export class Pipes {
  create(x: number): number { return x; }
}
`);
    twoWidgets();
    write('src/screen.ts', `import { Widget } from './w1';
export class Screen {
  private widget: Widget;
  run() { this.widget.create(1); }
}
`);
    const store = await indexed();

    expect(listed(store, 'Pipes.create')).toEqual([]);
    store.close();
  }, 30000);

  // The rule must not hide a real miss. When the written type IS the target's own
  // class, the row stays: that is exactly the call the reader is looking for.
  it('keeps a call on the target class itself', async () => {
    write('src/p1.ts', `export class Pipes {
  create(x: number): number { return x; }
}
`);
    write('src/p2.ts', `export class Pipes {
  create(x: number): number { return x; }
}
`);
    write('src/screen.ts', `import { Pipes } from './p1';
export class Screen {
  private pipes: Pipes;
  run() { this.pipes.create(1); }
}
`);
    const store = await indexed();

    expect(listed(store, 'Pipes.create')).toEqual(['src/screen.ts:4']);
    store.close();
  }, 30000);

  // Nothing is written about the receiver, so nothing can be ruled out and the row
  // stays. Silence is not evidence.
  it('keeps a call whose receiver type is unknown', async () => {
    write('src/pipes.ts', `export class Pipes {
  create(x: number): number { return x; }
}
export class Other {
  create(x: number): number { return x; }
}
export function run(thing) { thing.create(1); }
`);
    const store = await indexed();

    expect(listed(store, 'Pipes.create')).toEqual(['src/pipes.ts:7']);
    store.close();
  }, 30000);

  // The same rule for a plain local. nest's spec files write
  // `let catsController: CatsController;` and then `catsController.create(cat)` —
  // the type is right there on the declaration even though six classes share the
  // name and the resolver has to refuse the call.
  it('leaves out a call on a local of a different type', async () => {
    write('src/pipes.ts', `export class Pipes {
  create(x: number): number { return x; }
}
`);
    twoWidgets();
    write('src/screen.ts', `import { Widget } from './w1';
export function run() {
  let w: Widget;
  w.create(1);
}
`);
    const store = await indexed();

    expect(listed(store, 'Pipes.create')).toEqual([]);
    store.close();
  }, 30000);

  // The same rule for a call written on a class name. `Widget.create(…)` says
  // Widget outright, so it is not a missing `Pipes.create`.
  it('leaves out a static call on a different class', async () => {
    write('src/pipes.ts', `export class Pipes {
  create(x: number): number { return x; }
}
`);
    twoWidgets();
    write('src/screen.ts', `import { Widget } from './w1';
export function run() { Widget.create(1); }
`);
    const store = await indexed();

    expect(listed(store, 'Pipes.create')).toEqual([]);
    store.close();
  }, 30000);
});
