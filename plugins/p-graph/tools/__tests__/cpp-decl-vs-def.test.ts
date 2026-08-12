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
});
