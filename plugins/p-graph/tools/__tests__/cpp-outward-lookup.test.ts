import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-cppout-')); });
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
const guessesInto = (store, bare) => store.db.prepare(
  `SELECT count(*) c FROM edges WHERE dst_bare = ? AND guess = 1 AND dst_id IS NOT NULL`).get(bare).c;

// C++ looks an unqualified name up in the class first, then in each enclosing
// namespace, then globally. p-graph recorded only the innermost reading, so a
// method calling a free function of its own namespace missed and fell through
// to a bare-name guess. Measured: 58% of leveldb's resolved call edges and 49%
// of re2's were guesses, against 11% for Go and 5% for Python. On leveldb's
// `TotalFileSize` every one of the six callers was right and every one was
// marked UNVERIFIED, and the agent then read version_set.cc five times over.
// See docs/measured-benefit.md.
describe('C++ unqualified name lookup walks outward', () => {
  it('a method reaching a free function of its own namespace is certain', async () => {
    write('src/geo.cc', `namespace geo {
double Scale(double v) { return v * 2; }
class Box {
 public:
  double Grow(double v);
};
double Box::Grow(double v) { return Scale(v); }
}
`);
    const store = await indexed();

    expect(store.callers('geo.Scale').map((n) => n.qname)).toEqual(['geo.Box.Grow']);
    expect(guessesInto(store, 'Scale')).toBe(0);
    store.close();
  }, 30000);

  it('a function in a namespace reaching a global function is certain', async () => {
    write('src/g.cc', `int Helper() { return 1; }
namespace geo {
int Use() { return Helper(); }
}
`);
    const store = await indexed();

    expect(store.callers('Helper').map((n) => n.qname)).toEqual(['geo.Use']);
    expect(guessesInto(store, 'Helper')).toBe(0);
    store.close();
  }, 30000);

  it('walks out one level at a time and stops at the first scope that has the name', async () => {
    write('src/n.cc', `namespace a {
int Pick() { return 1; }
namespace b {
int Pick() { return 2; }
class C {
 public:
  int Run();
};
int C::Run() { return Pick(); }
}
}
`);
    const store = await indexed();

    // `a::b` is nearer than `a`, so `a::b::Pick` is the answer and `a::Pick`
    // must not gain a caller it never had.
    expect(store.callers('a.b.Pick').map((n) => n.qname)).toEqual(['a.b.C.Run']);
    expect(store.callers('a.Pick')).toEqual([]);
    store.close();
  }, 30000);

  // The guard. If the class itself owns the name, C++ stops there and never
  // looks outward — even when it cannot tell which overload is meant.
  it('does not walk out when the class owns the name', async () => {
    write('src/own.cc', `namespace geo {
double Scale(double v) { return v; }
class Box {
 public:
  double Scale(double v) { return v * 3; }
  double Grow(double v) { return Scale(v); }
};
}
`);
    const store = await indexed();

    expect(store.callers('geo.Box.Scale').map((n) => n.qname)).toEqual(['geo.Box.Grow']);
    expect(store.callers('geo.Scale')).toEqual([]);
    store.close();
  }, 30000);

  it('does not walk out when the class owns the name through overloads', async () => {
    // Two definitions share the qname `geo.Box.Scale`, so no exact match is
    // possible. Measured on leveldb: `InternalKeyComparator::Compare` calling
    // its own other overload is exactly this shape. Answering with the
    // namespace function would be a wrong row marked certain, and `impact`
    // follows a certain row.
    write('src/ovl.cc', `namespace geo {
double Scale(double v) { return v; }
class Box {
 public:
  double Scale(double v);
  double Scale(int v);
  double Grow(double v) { return Scale(v); }
};
double Box::Scale(double v) { return v; }
double Box::Scale(int v) { return v; }
}
`);
    const store = await indexed();

    expect(store.callers('geo.Scale')).toEqual([]);
    store.close();
  }, 30000);

  it('refuses when the outer scope holds two symbols of that name', async () => {
    write('src/dup1.cc', `namespace geo {
double Scale(double v) { return v; }
}
`);
    write('src/dup2.cc', `namespace geo {
double Scale(int v) { return v; }
class Box {
 public:
  double Grow(double v) { return Scale(v); }
};
}
`);
    const store = await indexed();

    // Two candidates, and the source does not say which. A pick would be a guess
    // dressed up as a fact.
    const certain = store.db.prepare(
      `SELECT count(*) c FROM edges WHERE dst_bare='Scale' AND guess=0 AND dst_id IS NOT NULL`).get().c;
    expect(certain).toBe(0);
    store.close();
  }, 30000);

  // A call written on a value never does scope lookup in C++ — `fd.Flush()`
  // cannot reach `util::Flush`, however the scopes nest.
  it('never applies to a call written on a value', async () => {
    write('src/mem.cc', `namespace util {
void Flush() {}
class Sink {
 public:
  void Drain(int fd) { fd.Flush(); }
};
}
`);
    const store = await indexed();

    expect(store.callers('util.Flush')).toEqual([]);
    store.close();
  }, 30000);

  // Other languages qualify their qnames by lexical nesting too, but their own
  // scope rules are already handled by Pass L. This pass must not touch them.
  it('leaves other languages alone', async () => {
    write('a.ts', `function scale(v: number) { return v; }
class Box {
  grow(v: number) { return scale(v); }
}
`);
    const store = await indexed();

    // TypeScript already resolves this through lexical scope, and it must stay
    // exactly as certain as it was.
    expect(store.callers('scale').map((n) => n.qname)).toEqual(['Box.grow']);
    store.close();
  }, 30000);
});
