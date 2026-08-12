import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-samefile-')); });
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

// C++ lets two .cc files each define their own class of the same name — a
// benchmark or a test copies a helper rather than sharing a header. Both end up
// with the same qname, and a pass that refuses whenever a qname is not unique
// gives up on a call that has only one possible answer: the class in the file the
// call is written in.
//
// Measured on leveldb: three benchmark files each define `RandomGenerator`, and
// 371 calls on a local variable whose type the graph already knew stayed
// unresolved for exactly this reason.
describe('a C++ call on a local whose class name is reused in another file', () => {
  beforeEach(() => {
    write('bench/one.cc', `namespace bench {
class Gen {
 public:
  int Make(int n) { return n; }
};
int RunOne() {
  Gen gen;
  return gen.Make(3);
}
}
`);
    write('bench/two.cc', `namespace bench {
class Gen {
 public:
  int Make(int n) { return n + 1; }
};
int RunTwo() {
  Gen gen;
  return gen.Make(4);
}
}
`);
  });

  it('resolves each call to the class defined in its own file', async () => {
    const store = await indexed();
    const callers = store.callers('bench.Gen.Make').filter((r) => !r.guess);
    expect(callers.map((r) => `${r.file}:${r.qname}`).sort())
      .toEqual(['bench/one.cc:bench.RunOne', 'bench/two.cc:bench.RunTwo']);
    store.close();
  }, 30000);

  it('leaves nothing in the gap report for those calls', async () => {
    const store = await indexed();
    const gaps = store.gapsFor('bench.Gen.Make')
      .filter((g) => g.reason !== 'external' && g.reason !== 'library');
    expect(gaps).toEqual([]);
    store.close();
  }, 30000);

  it('still refuses when the name is reused in a file the call does not live in', async () => {
    write('bench/three.cc', `namespace bench {
int RunThree(Gen& g) { return g.Make(5); }
}
`);
    const store = await indexed();
    // `Gen` is declared in neither one.cc nor two.cc as far as three.cc can see,
    // and two classes carry the qname, so there is no single right answer. The
    // call must not be linked to one of them by a coin toss.
    const three = store.callers('bench.Gen.Make').filter((r) => r.file === 'bench/three.cc');
    expect(three.filter((r) => !r.guess)).toEqual([]);
    store.close();
  }, 30000);
});
