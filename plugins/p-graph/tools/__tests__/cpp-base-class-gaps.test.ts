import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-cppbase-')); });
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
const gapLines = (store, qname) => store.gapsFor(qname).map((r) => `${r.file}:${r.line}`);

// A call written on a receiver the source types as a SUBCLASS is a real call site
// of a method the BASE declares. The gap report used to drop such a row, because
// "the source types the receiver as some other repo type" is read as proof the
// call is not this target's. For C++ that proof does not hold: nothing in the
// graph records C++ inheritance, so a subclass is indistinguishable from an
// unrelated class.
//
// Dropping it is worse than listing it. The row left the report AND the answer
// printed `complete`, which the installed rule reads as "stop. Do not grep." So
// the answer was short and told the reader not to check.
//
// Measured on rocksdb: `callers "CompactionPicker::ExpandInputsToCleanCut"` gave
// 10 of the 12 real call sites, an empty gap list and `✓ complete`. The two it
// lost are `picker_->ExpandInputsToCleanCut(...)` in compaction_picker_universal.cc,
// where `picker_` is a `UniversalCompactionPicker*` and that class derives from
// CompactionPicker. All three graph runs missed them; grep found both.
describe('a C++ call through a base class is reported, never silently dropped', () => {
  it('lists the call site instead of claiming complete', async () => {
    write('src/a.h', `namespace db {
class Base {
 public:
  bool Widen(int n);
};
class Derived : public Base {
 public:
  bool Pick();
};
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

    // Either it resolves as a caller or it is reported as a gap. What it must
    // never be is absent from both while the answer says nothing is missing.
    const callers = store.callers('db.Base.Widen').map((r) => r.qname);
    const gaps = gapLines(store, 'db.Base.Widen');
    expect(callers.includes('db.Runner.Go') || gaps.includes('src/a.cc:4')).toBe(true);
    store.close();
  }, 30000);

  it('says the same for two classes deriving from one base', async () => {
    write('src/a.h', `namespace db {
class Base {
 public:
  bool Widen(int n);
};
class First : public Base {};
class Second : public Base {};
class Runner {
 public:
  bool Go();
  bool Stop();
 private:
  First* a_;
  Second* b_;
};
}
`);
    write('src/a.cc', `#include "a.h"
namespace db {
bool Base::Widen(int n) { return n > 0; }
bool Runner::Go() { return a_->Widen(1); }
bool Runner::Stop() { return b_->Widen(2); }
}
`);
    const store = await indexed();

    const callers = store.callers('db.Base.Widen').map((r) => r.qname);
    const gaps = gapLines(store, 'db.Base.Widen');
    for (const line of ['src/a.cc:4', 'src/a.cc:5']) {
      expect(callers.includes('db.Runner.Go') || callers.includes('db.Runner.Stop')
        || gaps.includes(line)).toBe(true);
    }
    store.close();
  }, 30000);

  it('a base class outside the repo is still not a reason to claim complete', async () => {
    write('src/a.h', `#include <vector>
namespace db {
class Base {
 public:
  bool Widen(int n);
};
class Derived : public std::vector<int> {
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

    // Derived declares its own Widen, so this call belongs to Derived and must
    // NOT be listed under Base. This is the case the drop exists for, and it has
    // to keep working.
    expect(gapLines(store, 'db.Base.Widen')).not.toContain('src/a.cc:5');
    expect(store.callers('db.Derived.Widen').map((r) => r.qname)).toContain('db.Runner.Go');
    store.close();
  }, 30000);

  it('an unrelated repo type that owns the name keeps its call out of the report', async () => {
    // The regression this must not cause. Measured on nest: 168 unrelated
    // `create` calls once landed in `PipesContextCreator.create`'s gap list, and
    // on re2 204 of 290 rows on `Prog::size` were `size()` on a std::vector.
    // Neither may come back.
    write('src/a.cc', `namespace db {
class Wanted {
 public:
  void run() {}
};
class Other {
 public:
  void run() {}
};
void Go() { Other o; o.run(); }
}
`);
    const store = await indexed();

    expect(gapLines(store, 'db.Wanted.run')).toEqual([]);
    expect(store.callers('db.Other.run').map((r) => r.qname)).toEqual(['db.Go']);
    store.close();
  }, 30000);
});
