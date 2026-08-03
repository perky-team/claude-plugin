import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';
import { resolveLang } from '../lib/parse/index.mjs';
import { extract } from '../lib/parse/driver.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-cpp-')); });
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
const cppNodes = async (source) => {
  const cfg = resolveLang('s.cc');
  const { nodes, edges } = await extract({
    file: 's.cc', lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source });
  return { nodes, edges };
};

describe('C++ header and implementation split', () => {
  it('indexes an out-of-class method definition and finds its caller', async () => {
    write('include/store.h', `#pragma once
#include <string>
class PgStore {
 public:
  std::string Get(int id);
  void Put(int id, const std::string& v);
};
`);
    write('src/store.cpp', `#include "store.h"
std::string PgStore::Get(int id) { return ""; }
void PgStore::Put(int id, const std::string& v) { Get(id); }
`);
    write('src/main.cpp', `#include "store.h"
int main() {
  PgStore s;
  s.Get(1);
  return 0;
}
`);
    const store = await indexed();

    expect(store.node('PgStore.Get')).toBeTruthy();
    expect(store.node('PgStore.Put')).toBeTruthy();
    expect(store.callers('PgStore.Get').map((n) => n.qname)).toContain('PgStore.Put');

    store.close();
  }, 30000);

  it('creates an edge for a namespace-qualified call', async () => {
    write('src/geo.h', `#pragma once
namespace geo { double TotalArea(const double* a, int n); }
`);
    write('src/geo.cpp', `#include "geo.h"
namespace geo { double TotalArea(const double* a, int n) { return 0; } }
`);
    write('src/main.cpp', `#include "geo.h"
int main() { double a[1] = {1}; return (int)geo::TotalArea(a, 1); }
`);
    const store = await indexed();

    // Before this task a qualified_identifier call produced no edge at all, so
    // there was nothing for the gap report to show either.
    const edges = store.db.prepare(
      `SELECT count(*) c FROM edges WHERE kind='call' AND dst_bare='TotalArea'`).get().c;
    expect(edges).toBeGreaterThan(0);

    store.close();
  }, 30000);

  it('resolves a namespace-qualified call to the function in that namespace', async () => {
    write('src/geo.cpp', `namespace geo { double TotalArea(int n) { return 0; } }
int main() { return (int)geo::TotalArea(1); }
`);
    const store = await indexed();

    // The call site named the namespace itself, so this is a fact, not a guess.
    expect(store.callers('geo.TotalArea').map((n) => n.qname)).toEqual(['main']);
    const guesses = store.db.prepare(
      `SELECT count(*) c FROM edges WHERE dst_bare='TotalArea' AND guess=1`).get().c;
    expect(guesses).toBe(0);

    store.close();
  }, 30000);

  it('lets a member call reach an out-of-class definition', async () => {
    write('include/store.h', `#pragma once
class PgStore {
 public:
  int Get(int id);
};
`);
    write('src/store.cpp', `#include "store.h"
int PgStore::Get(int id) { return id; }
`);
    write('src/main.cpp', `#include "store.h"
int main() { PgStore s; return s.Get(1); }
`);
    const store = await indexed();

    // The definition sits in another file than its class, so it has no owner in
    // its own file. Its qname still says which class it belongs to, and that is
    // what a member call has to be allowed to reach.
    expect(store.callers('PgStore.Get').map((n) => n.qname)).toContain('main');

    store.close();
  }, 30000);

  it('names every out-of-class declarator shape', async () => {
    const { nodes } = await cppNodes(`class Buf {
 public:
  char* Data();
};
char* Buf::Data() { return 0; }
Buf& Buf::Self() { return *this; }
char*& Buf::Ref() { return p_; }
int Buf::Size() const { return 0; }
Buf::Buf() {}
Buf::~Buf() {}
bool Buf::operator==(const Buf& o) const { return true; }
double geo::Area(int n) { return 0; }
template <typename T> T Vec<T>::At(int i) { return T(); }
namespace ns { void Free() {} }
`);
    const qnames = nodes.map((n) => n.qname);
    for (const want of ['Buf.Data', 'Buf.Self', 'Buf.Ref', 'Buf.Size', 'Buf.Buf',
      'Buf.~Buf', 'Buf.operator==', 'geo.Area', 'Vec.At', 'ns.Free']) {
      expect(qnames, want).toContain(want);
    }

    // An anonymous namespace names nothing. Reading a name out of it would make
    // the first symbol inside the block look like the namespace's own name.
    const { nodes: anon } = await cppNodes(`namespace { void Hidden() {} }
`);
    expect(anon.map((n) => n.qname)).toEqual(['Hidden']);
  }, 30000);

  it('reads the class name past an export macro', async () => {
    // A macro between `class` and the name makes tree-sitter read the whole class
    // as a function definition. Every public class in leveldb is written this
    // way, and without help each of its methods looks like a free function.
    const { nodes } = await cppNodes(`namespace lib {
class LIB_EXPORT Slice {
 public:
  size_t size() const;
};
struct LIB_EXPORT Range {
  int span() const { return 1; }
};
class Plain;
}
size_t lib::Slice::size() const { return 0; }
`);
    const qnames = nodes.map((n) => n.qname);
    // The class has to be here under its real name, or the definition below —
    // whose qname says `lib.Slice.size` — belongs to an owner nobody indexed,
    // and a member call is refused for want of it.
    expect(qnames).toContain('lib.Slice');
    expect(qnames).toContain('lib.Slice.size');
    expect(qnames).toContain('lib.Range.span');
    // The macro is not a class name, and a forward declaration is not a second
    // copy of the class: both would duplicate a qname, and `node`/`impact` pick
    // one such node at random.
    expect(qnames).not.toContain('lib.LIB_EXPORT');
    expect(qnames.filter((q) => q === 'lib.Plain')).toEqual([]);
  }, 30000);

  it('reports an unresolved qualified call instead of staying silent', async () => {
    write('src/geo.h', `#pragma once
namespace geo { double TotalArea(const double* a, int n); }
`);
    write('src/geo.cpp', `#include "geo.h"
namespace geo { double TotalArea(const double* a, int n) { return 0; } }
`);
    // `shape` is not a namespace this repo defines, so the call cannot be
    // linked. It must still show up as a gap: silence reads as "no callers".
    write('src/main.cpp', `#include "geo.h"
int main() { double a[1] = {1}; return (int)shape::TotalArea(a, 1); }
`);
    const store = await indexed();

    expect(store.gapsFor('TotalArea').map((g) => `${g.file}:${g.line}`))
      .toContain('src/main.cpp:2');

    store.close();
  }, 30000);

  it('keeps a C++ member access away from a namespace function', async () => {
    write('src/util.cpp', `namespace util { void Flush() {} }
void run(int fd) { fd.Flush(); }
`);
    const store = await indexed();

    // In C++ a dot or an arrow never reaches a namespace member — the source
    // must write `util::Flush()`. So `fd.Flush()` is a call on something whose
    // type we do not know, not a call into the namespace.
    expect(store.callers('util.Flush')).toEqual([]);

    store.close();
  }, 30000);
});
