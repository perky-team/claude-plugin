import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-cppscope-')); });
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

// A bare type name in C++ is looked up from the innermost scope outwards. Written
// inside `namespace leveldb`, `Iterator it;` means `leveldb::Iterator` — never the
// nested `leveldb::SkipList::Iterator`, which would have to be written out. The
// resolver was refusing whenever two repo classes shared the short name, so both
// readings were thrown away and the call went unresolved.
//
// Measured on leveldb: 382 calls sat unresolved for exactly this reason, `Iterator`
// alone accounting for most of them.
describe('a C++ type name that two classes share', () => {
  beforeEach(() => {
    write('inc/iter.h', `#pragma once
namespace db {
class Iterator {
 public:
  bool Valid() const;
  void Next();
};
class SkipList {
 public:
  class Iterator {
   public:
    bool Valid() const;
    void Next();
  };
};
}
`);
    write('src/scan.cc', `#include "iter.h"
namespace db {
int Scan(Iterator* src) {
  Iterator it;
  int n = 0;
  while (it.Valid()) { it.Next(); n++; }
  return n;
}
}
`);
  });

  it('picks the class in the nearest enclosing scope', async () => {
    const store = await indexed();
    expect(store.callers('db.Iterator.Valid').filter((r) => !r.guess).map((r) => r.qname))
      .toEqual(['db.Scan']);
    store.close();
  }, 30000);

  it('does not link the call to the nested class of the same name', async () => {
    const store = await indexed();
    expect(store.callers('db.SkipList.Iterator.Valid').filter((r) => !r.guess)).toEqual([]);
    store.close();
  }, 30000);

  it('still picks the nested class when the source writes it out', async () => {
    write('src/inner.cc', `#include "iter.h"
namespace db {
int Inner() {
  SkipList::Iterator it;
  return it.Valid() ? 1 : 0;
}
}
`);
    const store = await indexed();
    expect(store.callers('db.SkipList.Iterator.Valid').filter((r) => !r.guess).map((r) => r.qname))
      .toEqual(['db.Inner']);
    store.close();
  }, 30000);
});
