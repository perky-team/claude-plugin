import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-cb-')); });
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
const qnames = (rows) => rows.map((r) => r.qname).sort();
const names = (rows) => rows.map((r) => r.name).sort();

// A function passed as a call argument is not a declaration, so nothing named it
// and every call inside it had no caller. In TypeScript that is where nearly all
// test code lives: 94% of this repo's own TS call sites had no caller before this.
describe('a function passed as a call argument gets a caller', () => {
  it('names a call in a test callback after the test', async () => {
    write('src/probe.ts', `export function target() { return 1; }
export function named(xs: number[]) {
  return xs.map(x => target() + x);
}
describe('suite', () => {
  it('case', () => { target(); });
});
`);
    const store = await indexed();

    // Two facts in one assertion. `describe:suite.it:case` is what this task
    // adds. `named` is the TRAP: the inline arrow on line 3 must NOT become a
    // definition, or the caller there reads `map@3` — useless to a human — and
    // `impact` stops at it, because nothing calls an arrow passed as a value.
    expect(qnames(store.callers('target'))).toEqual(['describe:suite.it:case', 'named']);
    store.close();
  }, 30000);

  it('attributes to the innermost callback, so `it` wins over `describe`', async () => {
    write('src/nest.ts', `export function target() { return 1; }
describe('suite', () => {
  target();
  it('case', () => { target(); });
});
`);
    const store = await indexed();

    expect(qnames(store.callers('target')))
      .toEqual(['describe:suite', 'describe:suite.it:case']);
    store.close();
  }, 30000);

  it('does not borrow the name of a definition written inside it', async () => {
    // The driver names a definition after the outermost `@name` capture inside
    // its span. For a callback that capture belongs to something else — a nested
    // `function helper()` — so the callback would be called `helper`.
    write('src/inner.ts', `export function target() { return 1; }
it('case', () => {
  function helper() { target(); }
  helper();
});
`);
    const store = await indexed();

    // `helper` keeps the BARE qname it had before this feature existed — see the
    // next test for why that matters — and the callback is named after its call.
    expect(qnames(store.callers('target'))).toEqual(['helper']);
    expect(names(store.callers('helper'))).toEqual(['it:case']);
    store.close();
  }, 30000);

  it('does not qualify a declaration written inside it', async () => {
    // A callback is not a namespace, and a qname must not move because of this
    // feature: Pass A calls a bare-name match CERTAIN when exactly one node in the
    // language carries that qname, so moving a test helper under `describe:…`
    // makes an ambiguous name look unique and unlocks a FALSE certain row.
    //
    // Measured on this repo before the rule was added: `io.test.ts` asks for
    // `readJobState`, which it imports from `lib/io.mjs`. Two TypeScript test
    // helpers shared that bare name, so the call was honestly unresolved. Moving
    // one of them under its `describe` left the other unique, and three call sites
    // linked CERTAINLY to an unrelated helper in another test file.
    write('lib/io.mjs', 'export function readJobState() { return 1; }\n');
    write('a.test.ts', `const readJobState = () => 2;
describe('a', () => {
  it('one', () => { readJobState(); });
});
`);
    write('b.test.ts', `describe('b', () => {
  const readJobState = () => 3;
  it('two', () => { readJobState(); });
});
`);
    write('c.test.ts', `describe('c', () => {
  it('three', () => { readJobState(); });
});
`);
    const store = await indexed();

    // Each test file's own helper still answers its own call — that is Pass L,
    // reading lexical scope, and it is knowledge.
    expect(store.callees('it:one').map((r) => r.file)).toEqual(['a.test.ts']);
    expect(store.callees('it:two').map((r) => r.file)).toEqual(['b.test.ts']);
    // c.test.ts has no helper of its own and imports nothing. Two TypeScript
    // nodes still carry the bare qname `readJobState`, so the graph must refuse.
    expect(store.callees('it:three')).toEqual([]);
    store.close();
  }, 30000);

  it('falls back to the line when the call passes no string', async () => {
    write('src/hook.ts', `export function target() { return 1; }
beforeEach(() => { target(); });
`);
    const store = await indexed();

    expect(names(store.callers('target'))).toEqual(['beforeEach@2']);
    store.close();
  }, 30000);

  it('names a callback passed to the result of a call', async () => {
    // `it.runIf(cond)('case', cb)` calls the RESULT of a call, so the callee has
    // to be read one level in. 50 call sites in this repo are written that way.
    write('src/runif.ts', `export function target() { return 1; }
it.runIf(process.platform !== 'win32')('case', () => { target(); });
`);
    const store = await indexed();

    expect(names(store.callers('target'))).toEqual(['runIf:case']);
    store.close();
  }, 30000);

  it('keeps a named definition as the caller of a callback inside it', async () => {
    // The same trap as the first test, in the two other shapes that already
    // worked: a class method, and an arrow bound to a const.
    write('src/keep.ts', `export function target() { return 1; }
class A { m() { [1].forEach(() => { target(); }); } }
const f = () => { it('inner', () => { target(); }); };
`);
    const store = await indexed();

    expect(qnames(store.callers('target'))).toEqual(['A.m', 'f']);
    store.close();
  }, 30000);

  it('does the same in JavaScript', async () => {
    write('src/probe.mjs', `export function target() { return 1; }
describe('suite', () => {
  it('case', () => { target(); });
});
`);
    const store = await indexed();

    expect(qnames(store.callers('target'))).toEqual(['describe:suite.it:case']);
    store.close();
  }, 30000);

  it('never becomes the target of a call', async () => {
    // No identifier can hold a `:` or a `@`, so a call written `it(...)` cannot
    // match a node named `it:case`. That is why no resolver pass had to change.
    write('src/target.ts', `it('case', () => { helper(); });
function helper() { return 1; }
`);
    const store = await indexed();

    expect(names(store.callees('it:case'))).toEqual(['helper']);
    expect(names(store.callers('helper'))).toEqual(['it:case']);
    store.close();
  }, 30000);

  it('flattens a multi-line template literal used as a test name', async () => {
    // A newline inside a qname would break one line of `callers` output into two.
    write('src/tpl.ts', `export function target() { return 1; }
it(\`a name
   over two lines\`, () => { target(); });
`);
    const store = await indexed();

    expect(names(store.callers('target'))).toEqual(['it:a name over two lines']);
    store.close();
  }, 30000);
});
