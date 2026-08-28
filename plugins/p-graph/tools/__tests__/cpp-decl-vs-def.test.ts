import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-cppdecl-')); });
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

// A pure virtual CAN have a definition: C++ allows it, and leveldb uses it for
// every convenience method on its interfaces — `virtual Status Put(…) = 0;` in
// db.h and `Status DB::Put(…) { … }` in db_impl.cc. Indexing both gave one qname
// two nodes, so the exact-qname pass refused them, `db_->Put(…)` stopped
// resolving, and the two calls turned up in the gap report of an unrelated
// symbol. Measured cost: the ⚠ banner on an otherwise complete
// `callers "WriteBatch::Put"` answer sent the agent grepping, and the whole
// question cost the same as it did with no graph at all.
//
// So a declaration yields to a definition: when the repo defines the method, the
// declaration's node is dropped and only the definition stays.
describe('a declared method yields to its definition', () => {
  it('a pure virtual with an in-repo definition leaves one node', async () => {
    write('include/db.h', `#pragma once
namespace db {
class DB {
 public:
  virtual int Put(int k) = 0;
  virtual int Get(int k) = 0;
};
}
`);
    write('src/db.cc', `#include "db.h"
namespace db {
int DB::Put(int k) { return k; }
}
`);
    const store = await indexed();

    const puts = store.db.prepare(
      `SELECT file, start_line FROM nodes WHERE qname = 'db.DB.Put'`).all();
    expect(puts).toHaveLength(1);
    expect(puts[0].file).toBe('src/db.cc');
    // The one with no definition keeps its declaration node — that is the whole
    // point of indexing pure virtuals.
    expect(store.node('db.DB.Get')).toBeTruthy();
    store.close();
  }, 30000);

  it('the call through the interface reaches the definition, not a dead end', async () => {
    write('include/db.h', `#pragma once
namespace db {
class DB {
 public:
  virtual int Put(int k) = 0;
};
}
`);
    write('src/db.cc', `#include "db.h"
namespace db {
int DB::Put(int k) { return k; }
int Run(DB* d) { return d->Put(1); }
}
`);
    const store = await indexed();

    expect(store.callers('db.DB.Put').filter((r) => !r.guess).map((r) => r.qname))
      .toEqual(['db.Run']);
    store.close();
  }, 30000);

  // The same shape behind an export macro, which is how leveldb writes it.
  it('works when the class name came from a macro', async () => {
    write('include/db.h', `#pragma once
namespace db {
class DB_EXPORT DB {
 public:
  virtual int Put(int k) = 0;
  virtual int Get(int k) = 0;
};
}
`);
    write('src/db.cc', `#include "db.h"
namespace db {
int DB::Put(int k) { return k; }
int Run(DB* d) { return d->Put(1); }
}
`);
    const store = await indexed();

    expect(store.db.prepare(`SELECT COUNT(*) c FROM nodes WHERE qname = 'db.DB.Put'`).get().c).toBe(1);
    expect(store.callers('db.DB.Put').filter((r) => !r.guess).map((r) => r.qname)).toEqual(['db.Run']);
    expect(store.node('db.DB.Get')).toBeTruthy();
    store.close();
  }, 30000);

  // A call to a method that is only ever declared must not be dropped from the
  // gap report just because the declaration is there — it is still unresolved.
  it('an interface method with no definition still answers', async () => {
    write('include/db.h', `#pragma once
namespace db {
class DB_EXPORT DB {
 public:
  virtual int Get(int k) = 0;
};
}
`);
    write('src/use.cc', `#include "db.h"
namespace db {
int Run(DB* d) { return d->Get(1); }
}
`);
    const store = await indexed();

    expect(store.callers('db.DB.Get').filter((r) => !r.guess).map((r) => r.qname)).toEqual(['db.Run']);
    store.close();
  }, 30000);

  // The ts/js language join (see SAME_LANG) must not spill into `definitionWins`
  // and change C++. `Base::eject` is a pure virtual with no definition of its
  // own; `Impl::eject` is an unrelated class's real definition of a method with
  // the same bare name. Before the ts/js join existed, the bare name `eject` had
  // two candidate nodes and Pass B refused — an honest gap. `definitionWins`
  // must keep refusing here: a pure virtual is not a declaration of `Impl`'s
  // method, so it must go on counting as a rival, and the study's published C++
  // numbers were measured with that refusal in place.
  it('a pure virtual elsewhere does not let a bare call resolve to an unrelated definition', async () => {
    write('base.h', `#pragma once
class Base {
 public:
  virtual void eject(int x) = 0;
};
`);
    write('impl.cc', `class Impl {
 public:
  void eject(int x);
};

void Impl::eject(int x) {}
`);
    write('use.cc', `void run() { eject(7); }
`);
    const store = await indexed();

    // Two candidate nodes for the bare name: the pure virtual and the real definition.
    expect(store.db.prepare(`SELECT COUNT(*) c FROM nodes WHERE name = 'eject'`).get().c).toBe(2);
    // Pass B must refuse rather than guess: dst_id stays unset, an honest gap.
    const edge = store.db.prepare(
      `SELECT dst_id, guess FROM edges WHERE kind = 'call' AND dst_name = 'eject'`).get();
    expect(edge.dst_id).toBeNull();
    store.close();
  }, 30000);
});
