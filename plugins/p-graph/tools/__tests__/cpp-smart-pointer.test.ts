import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-cppsmart-')); });
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

// `std::shared_ptr<Sink> s; s->log(msg);` runs `Sink::log`. The smart pointer is a
// library type but the call is not a library call — it goes straight through to
// what the pointer holds. Small in number (six calls across leveldb, re2 and
// spdlog) but it has to be read anyway: without it the gap report files those
// calls as "receiver is a library type" and a real call site disappears.
describe('a C++ call through a smart pointer', () => {
  it('resolves to the class the pointer holds', async () => {
    write('sink.h', `#pragma once
#include <memory>
namespace app {
class Sink {
 public:
  void Emit(int v);
};
}
`);
    write('fan.cc', `#include "sink.h"
namespace app {
void Fan(std::shared_ptr<Sink> s) { s->Emit(1); }
void Own() {
  std::unique_ptr<Sink> u;
  u->Emit(2);
}
}
`);
    const store = await indexed();
    expect(store.callers('app.Sink.Emit').filter((r) => !r.guess).map((r) => r.qname).sort())
      .toEqual(['app.Fan', 'app.Own']);
    store.close();
  }, 30000);

  it('leaves a smart pointer to a type outside the repo alone', async () => {
    write('thing.h', `#pragma once
#include <memory>
namespace app {
class Widget {
 public:
  void Emit(int v);
};
}
`);
    write('use.cc', `#include "thing.h"
namespace app {
void Use(std::shared_ptr<ext::Gadget> g) { g->Emit(3); }
}
`);
    const store = await indexed();
    expect(store.callers('app.Widget.Emit').filter((r) => !r.guess)).toEqual([]);
    store.close();
  }, 30000);
});
