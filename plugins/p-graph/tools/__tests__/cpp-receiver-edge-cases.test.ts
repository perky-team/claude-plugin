import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-cppedge-')); });
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
const certain = (store, qname) => store.callers(qname).filter((r) => !r.guess).map((r) => r.qname);

// Both of these were found by running the A/B and reading the two call sites the
// graph still could not place. Each was one row in a gap banner, and one row is
// enough: the ⚠ line sends the reader to grep, so an answer that is right about 24
// call sites and short by one costs what having no graph at all costs.
describe('a local built with constructor arguments', () => {
  // `ModelDB model(Opts());` inside a function body is C++'s "most vexing parse":
  // it is syntactically a function declaration and tree-sitter reads it as one.
  // It is the everyday way to build an object, so the receiver type has to be read
  // out of it. Measured on leveldb: this shape is why `model.Put(…)` at
  // db_test.cc:2310 stayed unresolved.
  it('is read as a variable of that type', async () => {
    write('src/a.cc', `namespace db {
class Batch {
 public:
  void Put(int k) {}
};
int Opts() { return 1; }
void Run() {
  Batch b(Opts());
  b.Put(1);
}
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Batch.Put')).toEqual(['db.Run']);
    store.close();
  }, 30000);

  it('reaches a call nested deeper than the declaration', async () => {
    write('src/a.cc', `namespace db {
class Batch {
 public:
  void Put(int k) {}
};
int Opts() { return 1; }
void Run() {
  do {
    Batch b(Opts());
    for (int i = 0; i < 3; i++) { b.Put(i); }
  } while (false);
}
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Batch.Put')).toEqual(['db.Run']);
    store.close();
  }, 30000);

  // The guard: a real function declaration must not become a variable. At class or
  // file scope `T name(A a);` is a declaration and nothing else, so only a function
  // BODY is read this way — which is exactly where C++'s own ambiguity lives.
  it('a method declaration in a class body is still a declaration', async () => {
    write('include/a.h', `#pragma once
namespace db {
class Batch {
 public:
  void Put(int k);
};
}
`);
    write('src/a.cc', `#include "a.h"
namespace db {
void Batch::Put(int k) {}
}
`);
    const store = await indexed();

    // One node for the method, and no variable called `Put`.
    expect(store.db.prepare(
      `SELECT COUNT(*) c FROM nodes WHERE lang='cpp' AND kind IN ('function','method')
       AND qname='db.Batch.Put'`).get().c).toBe(1);
    expect(store.db.prepare(
      `SELECT COUNT(*) c FROM field_types WHERE key LIKE '%#var:Put%'`).get().c).toBe(0);
    store.close();
  }, 30000);
});

describe('two classes of the same name in different files', () => {
  // leveldb ships three benchmark programs, each with its own `class Benchmark`
  // and its own `db_` field of a different type — `DB*`, `sqlite3*`,
  // `kyotocabinet::TreeDB*`. Keying a field on the class's bare name alone put
  // three types under one key, so the type was ambiguous and every `db_->…` call
  // in all three files stayed unresolved. The file the declaration is in is what
  // tells them apart.
  it('each file uses the field type its own class declares', async () => {
    write('src/one.cc', `namespace db {
class Batch {
 public:
  void Put(int k) {}
};
class Bench {
 public:
  void Run() { d_.Put(1); }

 private:
  Batch d_;
};
}
`);
    write('src/two.cc', `namespace db {
class Other {
 public:
  void Put(int k) {}
};
class Bench {
 public:
  void Run() { d_.Put(2); }

 private:
  Other d_;
};
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Batch.Put')).toEqual(['db.Bench.Run']);
    expect(certain(store, 'db.Other.Put')).toEqual(['db.Bench.Run']);
    store.close();
  }, 30000);

  // The header/implementation split must keep working: there the declaration and
  // the use are in different files on purpose, so the class-wide key is the only
  // one that can answer.
  it('a field declared in a header still types a call in the .cc', async () => {
    write('include/a.h', `#pragma once
namespace db {
class Batch {
 public:
  void Put(int k);
};
class Writer {
 public:
  void Run();

 private:
  Batch rep_;
};
}
`);
    write('src/a.cc', `#include "a.h"
namespace db {
void Batch::Put(int k) {}
void Writer::Run() { rep_.Put(1); }
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Batch.Put')).toEqual(['db.Writer.Run']);
    store.close();
  }, 30000);
});

// `shard_[Shard(hash)].Insert(…)` in leveldb's cache: an array of a known type is
// still a known type, whichever element the subscript picks. Left out, this was one
// more row in a gap banner — and one row is enough to send the reader to grep.
describe('a receiver picked out of an array', () => {
  it('keeps the array element type', async () => {
    write('src/a.cc', `namespace db {
class Shard {
 public:
  void Insert(int k) {}
};
int Pick(int h) { return h; }
class Cache {
 public:
  void Add(int h) { shard_[Pick(h)].Insert(1); }

 private:
  Shard shard_[4];
};
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Shard.Insert')).toEqual(['db.Cache.Add']);
    store.close();
  }, 30000);

  it('works on a local array too', async () => {
    write('src/a.cc', `namespace db {
class Shard {
 public:
  void Insert(int k) {}
};
void Run() {
  Shard xs[2];
  xs[0].Insert(1);
}
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Shard.Insert')).toEqual(['db.Run']);
    store.close();
  }, 30000);
});

// leveldb's MemTable writes `typedef SkipList<const char*, KeyComparator> Table;`
// and then `Table table_;`. The declaration says the type is `Table`, and no class
// is called that — so the receiver stayed untyped and `table_.Insert(buf)` was the
// last row in the gap banner of an unrelated symbol.
describe('a receiver typed through an alias', () => {
  it('follows a typedef to the class it names', async () => {
    write('src/a.cc', `namespace db {
class Skip {
 public:
  void Insert(int k) {}
};
class MemTable {
 public:
  typedef Skip Table;
  void Add(int k) { table_.Insert(k); }

 private:
  Table table_;
};
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Skip.Insert')).toEqual(['db.MemTable.Add']);
    store.close();
  }, 30000);

  it('follows a using-alias too, and drops the template arguments', async () => {
    write('src/a.cc', `namespace db {
template <typename T>
class Skip {
 public:
  void Insert(int k) {}
};
using Table = Skip<int>;
void Run() {
  Table t;
  t.Insert(1);
}
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Skip.Insert')).toEqual(['db.Run']);
    store.close();
  }, 30000);

  it('refuses when one alias name is bound to two different types', async () => {
    write('src/one.cc', `namespace one {
class A { public: void Go() {} };
typedef A Alias;
}
`);
    write('src/two.cc', `namespace two {
class B { public: void Go() {} };
typedef B Alias;
void Run() { Alias x; x.Go(); }
}
`);
    const store = await indexed();

    // Two targets for one alias name and nothing in the source to choose between
    // them, so neither is claimed.
    expect(certain(store, 'one.A.Go')).toEqual([]);
    store.close();
  }, 30000);
});

// leveldb has BOTH `class Table` (table.h) and, inside MemTable,
// `typedef SkipList<…> Table;`. Inside MemTable the name means the typedef, so a
// class-scoped alias has to win over a same-named class elsewhere — which is what
// C++ itself does.
describe('an alias declared inside a class wins inside that class', () => {
  it('prefers the class-scoped typedef over a same-named class', async () => {
    write('src/a.cc', `namespace db {
class Skip {
 public:
  void Insert(int k) {}
};
class Table {
 public:
  void Other(int k) {}
};
class MemTable {
 public:
  typedef Skip Table;
  void Add(int k) { table_.Insert(k); }

 private:
  Table table_;
};
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Skip.Insert')).toEqual(['db.MemTable.Add']);
    expect(store.callers('db.Table.Other')).toEqual([]);
    store.close();
  }, 30000);
});
