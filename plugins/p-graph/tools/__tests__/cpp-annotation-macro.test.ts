import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-cppann-')); });
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

// A thread-safety annotation after the parameter list splits the parse in two: the
// real name stays behind in a declaration and the BODY becomes a definition named
// after the macro. Measured on leveldb: 15 nodes of 1,795 were called
// `LOCKS_EXCLUDED`, `EXCLUSIVE_LOCKS_REQUIRED` or the like, and the methods they
// stood in for — `PosixLockTable::Insert` among them — were in no answer at all.
// A wrong name is worse than a missing one, because search finds it and a reader
// believes it.
describe('a method annotated for thread safety keeps its own name', () => {
  it('is in the graph under its real name, and the macro is not', async () => {
    write('src/a.cc', `namespace db {
class Table {
 public:
  bool Insert(int f) LOCKS_EXCLUDED(mu_) { return true; }
  void Drop(int f) EXCLUSIVE_LOCKS_REQUIRED(mu_) {}
};
}
`);
    const store = await indexed();

    expect(store.node('db.Table.Insert')).toBeTruthy();
    expect(store.node('db.Table.Drop')).toBeTruthy();
    expect(store.db.prepare(
      `SELECT COUNT(*) c FROM nodes WHERE lang='cpp' AND name LIKE '%LOCKS%'`).get().c).toBe(0);
    store.close();
  }, 30000);

  it('a call on a typed receiver reaches it', async () => {
    write('src/a.cc', `namespace db {
class Table {
 public:
  bool Insert(int f) LOCKS_EXCLUDED(mu_) { return true; }
};
class Env {
 public:
  bool Lock(int f) { return locks_.Insert(f); }

 private:
  Table locks_;
};
}
`);
    const store = await indexed();

    expect(store.callers('db.Table.Insert').filter((r) => !r.guess).map((r) => r.qname))
      .toEqual(['db.Env.Lock']);
    store.close();
  }, 30000);
});

// Generalised from the pure-virtual rule: ANY method declaration in a class body
// earns a node, and it yields to a definition when the repo has one. That covers a
// pure virtual, a method whose body the parse lost to an annotation macro, and a
// method declared in a header this repo never implements — one rule instead of a
// list of special cases.
describe('a declared method earns a node and yields to its definition', () => {
  it('a header declaration with a definition leaves exactly one node', async () => {
    write('include/a.h', `#pragma once
namespace db {
class Store {
 public:
  int Get(int id);
  int Put(int id);
};
}
`);
    write('src/a.cc', `#include "a.h"
namespace db {
int Store::Get(int id) { return id; }
int Store::Put(int id) { return id; }
}
`);
    const store = await indexed();

    for (const q of ['db.Store.Get', 'db.Store.Put']) {
      const rows = store.db.prepare('SELECT file FROM nodes WHERE qname = ?').all(q);
      expect(rows, q).toHaveLength(1);
      expect(rows[0].file, q).toBe('src/a.cc');
    }
    store.close();
  }, 30000);

  it('a method this repo declares but never defines is still answerable', async () => {
    write('include/a.h', `#pragma once
namespace db {
class Store {
 public:
  int External(int id);
};
}
`);
    write('src/a.cc', `#include "a.h"
namespace db {
int Run(Store* s) { return s->External(1); }
}
`);
    const store = await indexed();

    expect(store.callers('db.Store.External').filter((r) => !r.guess).map((r) => r.qname))
      .toEqual(['db.Run']);
    store.close();
  }, 30000);
});
