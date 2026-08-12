import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-cpprecv-')); });
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
const guessCount = (store, bare) => store.db.prepare(
  `SELECT count(*) c FROM edges WHERE dst_bare = ? AND guess = 1 AND dst_id IS NOT NULL`).get(bare).c;

// A call written on a value — `x.m()`, `p->m()` — is 40% of leveldb's call edges
// and 43% of re2's, and before this change NOT ONE of leveldb's 3,681 was
// certain. C++ was the only supported language with no receiver-type table at
// all; Go, Python and TypeScript have had one for months. Measured by parsing
// every such receiver: 46.5% of them in leveldb and 41.6% in re2 name a repo
// class whose type the source writes in plain sight, and another 23–30% write an
// external type — which is a fact worth recording too, because it turns a wrong
// guess into an honest refusal. See docs/measured-benefit.md.
describe('C++ reads the receiver type the source writes', () => {
  it('a local variable with a written type', async () => {
    write('src/a.cc', `namespace db {
class Batch {
 public:
  void Put(int k) {}
};
void Run() { Batch b; b.Put(1); }
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Batch.Put')).toEqual(['db.Run']);
    expect(guessCount(store, 'Put')).toBe(0);
    store.close();
  }, 30000);

  it('a pointer local, and an initialiser does not hide the type', async () => {
    write('src/a.cc', `namespace db {
class Batch {
 public:
  void Put(int k) {}
};
Batch* Make() { return nullptr; }
void Run() { Batch* b = Make(); b->Put(1); }
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Batch.Put')).toEqual(['db.Run']);
    store.close();
  }, 30000);

  it('a parameter taken by reference or by pointer', async () => {
    write('src/a.cc', `namespace db {
class Batch {
 public:
  void Put(int k) {}
};
void ByRef(Batch& b) { b.Put(1); }
void ByPtr(Batch* b) { b->Put(2); }
void ByConstRef(const Batch& b) { b.Put(3); }
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Batch.Put').sort()).toEqual(['db.ByConstRef', 'db.ByPtr', 'db.ByRef']);
    store.close();
  }, 30000);

  it('a member field, with the method written inside the class', async () => {
    write('src/a.cc', `namespace db {
class Batch {
 public:
  void Put(int k) {}
};
class Writer {
 public:
  void Run() { rep_.Put(1); }

 private:
  Batch rep_;
};
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Batch.Put')).toEqual(['db.Writer.Run']);
    store.close();
  }, 30000);

  // The everyday C++ layout: the class in a header, the method in a .cc. The
  // field's declaration is then nowhere near the call, so the type has to be
  // recorded against the class and looked up by the enclosing class's name.
  it('a member field, with the method written outside the class', async () => {
    write('include/db.h', `#pragma once
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
    write('src/db.cc', `#include "db.h"
namespace db {
void Batch::Put(int k) {}
void Writer::Run() { rep_.Put(1); }
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Batch.Put')).toEqual(['db.Writer.Run']);
    store.close();
  }, 30000);

  it('a call through a field of a typed receiver', async () => {
    // `b->rep.Put(...)` — leveldb's C API does exactly this in db/c.cc.
    write('src/a.cc', `namespace db {
class Batch {
 public:
  void Put(int k) {}
};
struct Handle {
  Batch rep;
};
void Run(Handle* h) { h->rep.Put(1); }
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Batch.Put')).toEqual(['db.Run']);
    store.close();
  }, 30000);

  // An external type is knowledge too: it says the target is NOT the one repo
  // method that happens to share the name. Recording it turns a wrong guess into
  // an honest gap.
  it('an external type refuses the bare-name guess instead of taking it', async () => {
    write('src/a.cc', `#include <string>
namespace db {
class Batch {
 public:
  void size(int k) {}
};
int Run() { std::string s; return s.size(); }
}
`);
    const store = await indexed();

    expect(store.callers('db.Batch.size')).toEqual([]);
    // and the call is reported rather than dropped in silence
    expect(store.gapsFor('db.Batch.size').map((g) => g.line)).toContain(7);
    store.close();
  }, 30000);

  it('refuses when two classes share the type name', async () => {
    write('src/one.cc', `namespace one {
class Batch {
 public:
  void Put(int k) {}
};
}
`);
    write('src/two.cc', `namespace two {
class Batch {
 public:
  void Put(int k) {}
};
void Run() { Batch b; b.Put(1); }
}
`);
    const store = await indexed();

    // The written name fits two classes and the source does not say which. A pick
    // would be a guess wearing a fact's clothes.
    expect(certain(store, 'one.Batch.Put')).toEqual([]);
    store.close();
  }, 30000);

  it('leaves a receiver with no type written nearby exactly as it was', async () => {
    write('src/a.cc', `namespace db {
class Batch {
 public:
  void Put(int k) {}
};
}
void Run() { g_batch.Put(1); }
`);
    const store = await indexed();

    // Still a guess — the source never says what `g_batch` is. This is the 13% the
    // measurement says a type table cannot reach.
    expect(certain(store, 'db.Batch.Put')).toEqual([]);
    store.close();
  }, 30000);

  it('a variable declared in one block does not type a call in a sibling block', async () => {
    write('src/a.cc', `namespace db {
class Batch {
 public:
  void Put(int k) {}
};
class Other {
 public:
  void Put(int k) {}
};
void Run(bool f) {
  if (f) { Batch b; b.Put(1); }
  else { Other b; b.Put(2); }
}
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Batch.Put')).toEqual(['db.Run']);
    expect(certain(store, 'db.Other.Put')).toEqual(['db.Run']);
    store.close();
  }, 30000);
});
