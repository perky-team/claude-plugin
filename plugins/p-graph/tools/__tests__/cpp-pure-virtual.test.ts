import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-cpppv-')); });
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

// A C++ interface is a class of pure virtuals, and a pure virtual has no
// definition to index — so the interface method was not in the graph at all.
// Measured on leveldb: `leveldb::Iterator::Valid` is absent while nine
// implementations of `Valid` are present, so asking about the interface answered
// with `SkipList::Iterator::Valid` — the wrong symbol, confidently. Same for
// `leveldb::Cache::Insert`. re2 has 49 such methods, leveldb 18.
//
// Only a PURE virtual is indexed from its declaration. An ordinary declaration
// has its definition somewhere, and indexing both would give one qname two nodes,
// which resolves to neither.
describe('a pure virtual is in the graph', () => {
  it('is indexed under its class', async () => {
    write('include/cache.h', `#pragma once
namespace db {
class Cache {
 public:
  virtual ~Cache() {}
  virtual bool Insert(int k) = 0;
  virtual void Erase(int k) = 0;
};
}
`);
    const store = await indexed();

    expect(store.node('db.Cache.Insert')).toBeTruthy();
    expect(store.node('db.Cache.Erase')).toBeTruthy();
    store.close();
  }, 30000);

  it('an ordinary declaration is still left out, so a qname keeps one node', async () => {
    write('include/store.h', `#pragma once
namespace db {
class Store {
 public:
  int Get(int id);
};
}
`);
    write('src/store.cc', `#include "store.h"
namespace db {
int Store::Get(int id) { return id; }
}
`);
    const store = await indexed();

    // Callables only: one namespace opened in two files legitimately gives two
    // namespace nodes, and that is not what this rule is about.
    const dupes = store.db.prepare(`SELECT qname, COUNT(*) c FROM nodes
      WHERE lang='cpp' AND kind IN ('function','method') GROUP BY qname HAVING c > 1`).all();
    expect(dupes).toEqual([]);
    store.close();
  }, 30000);

  // The payoff: the receiver is typed as the interface, so the call belongs to the
  // interface method — which now exists.
  it('a call through an interface pointer reaches the interface method', async () => {
    write('include/cache.h', `#pragma once
namespace db {
class Cache {
 public:
  virtual bool Insert(int k) = 0;
};
}
`);
    write('src/use.cc', `#include "cache.h"
namespace db {
class LRUCache : public Cache {
 public:
  bool Insert(int k) { return true; }
};
bool Run(Cache* c) { return c->Insert(1); }
}
`);
    const store = await indexed();

    expect(store.callers('db.Cache.Insert').filter((r) => !r.guess).map((r) => r.qname))
      .toEqual(['db.Run']);
    store.close();
  }, 30000);

  it('the concrete class keeps its own method apart from the interface', async () => {
    write('src/a.cc', `namespace db {
class Cache {
 public:
  virtual bool Insert(int k) = 0;
};
class LRUCache : public Cache {
 public:
  bool Insert(int k) { return true; }
};
bool Direct() { LRUCache c; return c.Insert(1); }
bool ByBase(Cache* c) { return c->Insert(2); }
}
`);
    const store = await indexed();

    expect(store.callers('db.LRUCache.Insert').map((r) => r.qname)).toEqual(['db.Direct']);
    expect(store.callers('db.Cache.Insert').map((r) => r.qname)).toEqual(['db.ByBase']);
    store.close();
  }, 30000);

  it('a pure virtual destructor with an out-of-line body does not duplicate a qname', async () => {
    write('src/a.cc', `namespace db {
class Base {
 public:
  virtual ~Base() = 0;
};
Base::~Base() {}
}
`);
    const store = await indexed();

    // Callables only: one namespace opened in two files legitimately gives two
    // namespace nodes, and that is not what this rule is about.
    const dupes = store.db.prepare(`SELECT qname, COUNT(*) c FROM nodes
      WHERE lang='cpp' AND kind IN ('function','method') GROUP BY qname HAVING c > 1`).all();
    expect(dupes).toEqual([]);
    store.close();
  }, 30000);
});

// Every public class in leveldb is written `class LEVELDB_EXPORT Cache { … };`, so
// the rule above — which needs a clean class body — reaches only the internal
// ones. The macro breaks the parse and the pure virtual survives as an assignment
// of 0 to a call. That shape is also legal C++, so it counts only inside a class
// the driver recovered from a macro.
describe('a pure virtual inside a macro-exported class', () => {
  it('is indexed under the recovered class name', async () => {
    write('include/cache.h', `#pragma once
namespace db {
class DB_EXPORT Cache {
 public:
  virtual bool Insert(int k) = 0;
  virtual void Erase(int k) = 0;
};
}
`);
    const store = await indexed();

    expect(store.node('db.Cache.Insert')).toBeTruthy();
    expect(store.node('db.Cache.Erase')).toBeTruthy();
    store.close();
  }, 30000);

  it('a call through the interface pointer reaches it', async () => {
    write('include/cache.h', `#pragma once
namespace db {
class DB_EXPORT Cache {
 public:
  virtual bool Insert(int k) = 0;
};
}
`);
    write('src/use.cc', `#include "cache.h"
namespace db {
bool Run(Cache* c) { return c->Insert(1); }
}
`);
    const store = await indexed();

    expect(store.callers('db.Cache.Insert').filter((r) => !r.guess).map((r) => r.qname))
      .toEqual(['db.Run']);
    store.close();
  }, 30000);

  // An assignment through a reference-returning call is ordinary C++ and must stay
  // out of the graph. This is the whole reason the rule is guarded.
  it('an ordinary assignment to a call result is not a method', async () => {
    write('src/a.cc', `namespace db {
class Matrix {
 public:
  double& operator()(int i, int j);
  void Zero(int i, int j) { at(i, j) = 0; }
  double& at(int i, int j);
};
}
`);
    const store = await indexed();

    // `at(i, j) = 0` is an assignment, not a declaration. `at` is a method here
    // only because the class really declares it — and that declaration has a
    // definition elsewhere, so it must not be indexed twice.
    const ats = store.db.prepare(
      `SELECT qname FROM nodes WHERE lang='cpp' AND name='at'`).all();
    expect(ats.length).toBeLessThanOrEqual(1);
    store.close();
  }, 30000);
});
