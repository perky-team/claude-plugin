import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-lex-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};
async function indexed() {
  const store = openStore(':memory:');
  await indexFull({ root: dir, store, ignorePatterns: [] });
  return store;
}

// A top-level function in JS, TypeScript, Python or C++ has a BARE qname, so the
// exact-qname pass matched a plain `walk(...)` written anywhere in the repo and
// called the match CERTAIN. Found on p-graph's own source: `walk(true)` inside
// attachReadHelpers linked to build.mjs's walk, while the real target sat eleven
// lines above it in the same file. What the call site can see comes first.
describe('a name in scope beats a same-named symbol in another file', () => {
  it('links a shadowed call to the definition in its own scope, not the other file', async () => {
    write('lib/util.ts', 'export function walk(a: number) { return a; }\n');
    write('app/main.ts', `export function run() {
  const walk = (b: number) => b + 1;
  return walk(1);
}
`);
    const store = await indexed();

    // The call belongs to the closure `run.walk`, and that is knowledge — the
    // definition is right there in the same scope — so it stays certain.
    expect(store.callees('run').filter((r) => r.name === 'walk'))
      .toMatchObject([{ qname: 'run.walk', file: 'app/main.ts', guess: 0 }]);
    // And the unrelated file keeps its false caller off its list.
    expect(store.callers('walk').filter((r) => r.file === 'lib/util.ts')).toEqual([]);

    store.close();
  }, 30000);

  it('does the same in Python', async () => {
    write('lib/util.py', 'def walk(a):\n    return a\n');
    write('app/main.py', `def run():
    def walk(b):
        return b + 1
    return walk(1)
`);
    const store = await indexed();

    expect(store.callees('run').filter((r) => r.name === 'walk'))
      .toMatchObject([{ qname: 'run.walk', file: 'app/main.py', guess: 0 }]);
    store.close();
  }, 30000);

  // The gain, not just the fix: two files that each declare their own `helper`
  // used to leave BOTH calls unresolved — the qname pass saw two candidates and
  // refused, and so did the bare-name fallback. Each call has an answer in its
  // own file, and picking it is reading scope, not guessing.
  it('resolves a name each file declares for itself, and calls it certain', async () => {
    write('a/one.ts', `export function helper() { return 1; }
export function useOne() { return helper(); }
`);
    write('b/two.ts', `export function helper() { return 2; }
export function useTwo() { return helper(); }
`);
    const store = await indexed();

    expect(store.callees('useOne').filter((r) => r.name === 'helper'))
      .toMatchObject([{ file: 'a/one.ts', guess: 0 }]);
    expect(store.callees('useTwo').filter((r) => r.name === 'helper'))
      .toMatchObject([{ file: 'b/two.ts', guess: 0 }]);

    store.close();
  }, 30000);

  it('does not let a definition in a sibling scope claim a call outside it', async () => {
    write('lib/util.ts', 'export function walk(a: number) { return a; }\n');
    write('app/main.ts', `function other() {
  const walk = (b: number) => b + 1;
  return walk(2);
}
export function use() { return walk(1); }
`);
    const store = await indexed();

    // `use` cannot see other's closure, so its call keeps reaching the imported
    // shape it reached before — the same-scope rule must not widen to the file.
    expect(store.callees('use').filter((r) => r.name === 'walk'))
      .toMatchObject([{ file: 'lib/util.ts' }]);
    // ...while other's own call still finds the closure next to it.
    expect(store.callees('other').filter((r) => r.name === 'walk'))
      .toMatchObject([{ qname: 'other.walk', file: 'app/main.ts', guess: 0 }]);

    store.close();
  }, 30000);

  // A bare `walk()` inside a class method is NOT a call on the class. Only
  // `this.walk()` is, and a different rule answers that one. The enclosing class
  // spans the call site, so a scope rule that ignored what owns a member would
  // hand this call to the class's own method and call it certain.
  it('never turns a bare call into a call on the enclosing class', async () => {
    write('lib/util.ts', 'export function walk(a: number) { return a; }\n');
    write('app/main.ts', `export class Runner {
  walk(b: number) { return b; }
  run() { return walk(1); }
}
`);
    const store = await indexed();

    expect(store.callers('Runner.walk')).toEqual([]);
    expect(store.callees('Runner.run').filter((r) => r.name === 'walk'))
      .toMatchObject([{ file: 'lib/util.ts' }]);

    store.close();
  }, 30000);

  it('leaves a member call alone, even when the same name is in scope', async () => {
    write('app/main.ts', `function walk(a: number) { return a; }
export function run(o: any) { return o.walk(1); }
`);
    const store = await indexed();

    // `o.walk()` is written on a value whose type nothing recorded. A local
    // function of that name is not a candidate for it at all.
    expect(store.callers('walk')).toEqual([]);
    store.close();
  }, 30000);
});
