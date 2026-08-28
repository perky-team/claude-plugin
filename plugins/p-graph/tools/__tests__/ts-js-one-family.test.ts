import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsjs-')); });
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

// axios, cut down to the shape that was measured. The library is JavaScript, the
// tests are TypeScript, and a published `index.d.ts` restates the API. Asked who
// calls `InterceptorManager.eject`, the graph named 17 of 25 call sites and then
// said the answer was complete: the 8 it missed are all written in `.ts` files, and
// the bare-name fallback would only look at `ts` nodes. That is p-graph's worst
// question in the whole study and 24 of the 33 call sites it trails grep by.
//
// This fix is necessary but not sufficient to close that gap: the real 8 missing
// call sites are top-level statements, and `store.callers` inner-joins on the call's
// own symbol, so a top-level call still cannot be printed once resolved. Do not read
// this test as proof the axios recall number moved — it has not been re-measured.
describe('a call in TypeScript reaches a method defined in JavaScript', () => {
  beforeEach(() => {
    write('lib/InterceptorManager.js', `export default class InterceptorManager {
  eject(id) { this.handlers[id] = null; }
}
`);
    // The call sits inside an `it(...)` block, the way axios writes its tests.
    // It has to sit inside something: `callers` joins each call edge to the symbol
    // the call was written in, so a call at the top level of a file has no caller
    // to report and would never show up here however well it resolved.
    write('tests/use.ts', `import client from '../lib/client.js';
it('removes the handler', () => {
  client.interceptors.request.eject(1);
});
`);
  });

  it('resolves the call', async () => {
    const store = await indexed();

    const sites = store.callers('InterceptorManager.eject')
      .flatMap((c) => c.call_sites).map((s) => s.file);
    expect(sites).toContain('tests/use.ts');
    store.close();
  }, 30000);

  // Only by name — nothing read the receiver's type — so the row must say so.
  // A certain row here would be a false promise.
  it('marks it as a guess', async () => {
    const store = await indexed();

    const rows = store.callers('InterceptorManager.eject')
      .filter((c) => c.call_sites.some((s) => s.file === 'tests/use.ts'));
    expect(rows).toHaveLength(1);
    expect(rows[0].guess).toBe(1);
    store.close();
  }, 30000);

  // The regression this task exists to avoid. With `.d.ts` counted as a definition,
  // the bare name `eject` has two callable nodes once the languages are joined, the
  // "exactly one" guard refuses, and the call sites that resolved BEFORE this change
  // are lost. A declaration must not count while a definition of that name exists.
  it('is not blocked by a published declaration of the same API', async () => {
    write('index.d.ts', `export interface AxiosInterceptorManager {
  eject(id: number): void;
}
`);
    const store = await indexed();

    const sites = store.callers('InterceptorManager.eject')
      .flatMap((c) => c.call_sites).map((s) => s.file);
    expect(sites).toContain('tests/use.ts');
    store.close();
  }, 30000);

  // The declaration is kept, not deleted: it is a symbol of the repo and a reader
  // may ask about it by name.
  it('keeps the declared symbol in the graph', async () => {
    write('index.d.ts', `export interface AxiosInterceptorManager {
  eject(id: number): void;
}
`);
    const store = await indexed();

    expect(store.symbolsNamed('eject').map((n) => n.file)).toContain('index.d.ts');
    store.close();
  }, 30000);

  // Two real definitions are still ambiguous. Joining the languages must not turn
  // "we do not know which" into a guess.
  it('still refuses when two real definitions share the name', async () => {
    write('lib/Other.js', `export default class Other {
  eject(id) { return id; }
}
`);
    const store = await indexed();

    expect(store.symbolsNamed('eject')).toHaveLength(2);
    const sites = store.callers('InterceptorManager.eject')
      .flatMap((c) => c.call_sites).map((s) => s.file);
    expect(sites).not.toContain('tests/use.ts');
    store.close();
  }, 30000);
});
