import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-cppinherit-')); });
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

// C++ inheritance, recorded at last. Every other supported language had a way to
// cross the line a call takes from a receiver to a method it does not itself
// declare — TypeScript walks `extends`, Go walks embedding — and C++ had none, so
// a receiver typed as a SUBCLASS resolved to nothing.
//
// Measured on rocksdb, where 1,623 of 3,521 class declarations write a base
// class and the graph held zero of them: `callers
// "CompactionPicker::ExpandInputsToCleanCut"` gave 10 of 12 real call sites. The
// two missing were `picker_->ExpandInputsToCleanCut(...)`, with `picker_` a
// `UniversalCompactionPicker*` — a class that derives from CompactionPicker.
describe('C++ reads the base class the source writes', () => {
  it('a call on a subclass-typed field reaches the base method', async () => {
    write('src/a.h', `namespace db {
class Base {
 public:
  bool Widen(int n);
};
class Derived : public Base {};
class Runner {
 public:
  bool Go();
 private:
  Derived* picker_;
};
}
`);
    write('src/a.cc', `#include "a.h"
namespace db {
bool Base::Widen(int n) { return n > 0; }
bool Runner::Go() { return picker_->Widen(1); }
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Base.Widen')).toEqual(['db.Runner.Go']);
    store.close();
  }, 30000);

  it('walks two levels', async () => {
    write('src/a.h', `namespace db {
class Base {
 public:
  bool Widen(int n);
};
class Middle : public Base {};
class Leaf : public Middle {};
class Runner {
 public:
  bool Go();
 private:
  Leaf* leaf_;
};
}
`);
    write('src/a.cc', `#include "a.h"
namespace db {
bool Base::Widen(int n) { return n > 0; }
bool Runner::Go() { return leaf_->Widen(1); }
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Base.Widen')).toEqual(['db.Runner.Go']);
    store.close();
  }, 30000);

  it('the subclass own method still wins over the base', async () => {
    write('src/a.h', `namespace db {
class Base {
 public:
  bool Widen(int n);
};
class Derived : public Base {
 public:
  bool Widen(int n);
};
class Runner {
 public:
  bool Go();
 private:
  Derived* d_;
};
}
`);
    write('src/a.cc', `#include "a.h"
namespace db {
bool Base::Widen(int n) { return n > 0; }
bool Derived::Widen(int n) { return n < 0; }
bool Runner::Go() { return d_->Widen(1); }
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Derived.Widen')).toEqual(['db.Runner.Go']);
    expect(certain(store, 'db.Base.Widen')).toEqual([]);
    store.close();
  }, 30000);

  it('refuses when the class lists two base classes', async () => {
    // Multiple inheritance names no single base, and picking one would invent a
    // whole method set. The call stays unresolved — and the gap report keeps it,
    // which cpp-base-class-gaps.test.ts holds.
    write('src/a.h', `namespace db {
class Left {
 public:
  bool Widen(int n);
};
class Right {
 public:
  bool Narrow(int n);
};
class Both : public Left, public Right {};
class Runner {
 public:
  bool Go();
 private:
  Both* b_;
};
}
`);
    write('src/a.cc', `#include "a.h"
namespace db {
bool Left::Widen(int n) { return n > 0; }
bool Right::Narrow(int n) { return n < 0; }
bool Runner::Go() { return b_->Widen(1); }
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Left.Widen')).toEqual([]);
    store.close();
  }, 30000);

  it('refuses when two classes carry the base name', async () => {
    write('src/a.h', `namespace db {
class Base {
 public:
  bool Widen(int n);
};
class Derived : public Base {};
class Runner {
 public:
  bool Go();
 private:
  Derived* d_;
};
}
`);
    write('src/other.h', `namespace other {
class Base {
 public:
  bool Widen(int n);
};
}
`);
    write('src/a.cc', `#include "a.h"
namespace db {
bool Base::Widen(int n) { return n > 0; }
bool Runner::Go() { return d_->Widen(1); }
}
`);
    write('src/other.cc', `#include "other.h"
namespace other {
bool Base::Widen(int n) { return n > 0; }
}
`);
    const store = await indexed();

    // Two `Base`es and the clause writes the short name, so which one Derived
    // extends is not a fact this indexer holds.
    expect(certain(store, 'db.Base.Widen')).toEqual([]);
    expect(certain(store, 'other.Base.Widen')).toEqual([]);
    store.close();
  }, 30000);

  it('a struct base is read the same way', async () => {
    write('src/a.h', `namespace db {
struct Base {
  bool Widen(int n);
};
struct Derived : public Base {};
class Runner {
 public:
  bool Go();
 private:
  Derived* d_;
};
}
`);
    write('src/a.cc', `#include "a.h"
namespace db {
bool Base::Widen(int n) { return n > 0; }
bool Runner::Go() { return d_->Widen(1); }
}
`);
    const store = await indexed();

    expect(certain(store, 'db.Base.Widen')).toEqual(['db.Runner.Go']);
    store.close();
  }, 30000);
});
