import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';
import { resolveLang } from '../lib/parse/index.mjs';
import { extract } from '../lib/parse/driver.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-cppmacro-')); });
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
  const { nodes } = await extract({
    file: 's.cc', lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source });
  return nodes;
};

// Header-only C++ libraries write every out-of-class definition behind a macro:
// `SPDLOG_INLINE std::shared_ptr<logger> registry::get(...)`. tree-sitter does not
// know the macro, reads it as the return type, and then cannot parse what follows —
// it puts the real class name in an ERROR node and leaves the return type sitting
// where the class should be. Measured on spdlog: 337 of 1323 methods came out with
// a name like `std.shared_ptr.registry.get`, and `callers "registry.get"` answered
// with zero callers and a warning listing all 33.
describe('C++ out-of-class definition behind a macro', () => {
  it('names the owner, not the return type, for a qualified return', async () => {
    const nodes = await cppNodes(`class R { };
MACRO std::shared_ptr<L> R::get(int a) { return nullptr; }
`);
    const m = nodes.filter((n) => n.kind === 'method');
    expect(m.map((n) => n.qname)).toEqual(['R.get']);
  });

  it('names the owner, not the return type, for a plain return', async () => {
    const nodes = await cppNodes(`class R { };
MACRO int R::get(int a) { return a; }
`);
    expect(nodes.filter((n) => n.kind === 'method').map((n) => n.qname)).toEqual(['R.get']);
  });

  // The same source can parse two ways. With a short class name tree-sitter gives
  // up and leaves an ERROR node; with a longer one it silently reads the return
  // type as two more levels of scope and no ERROR appears at all. Both shapes are
  // in spdlog, so both are here.
  it('names the owner when the return type is read as extra scope, with no ERROR', async () => {
    const nodes = await cppNodes(
      'MACRO std::shared_ptr<logger> registry::get(int a) { return nullptr; }\n');
    expect(nodes.filter((n) => n.kind === 'method').map((n) => n.qname)).toEqual(['registry.get']);
  });

  it('names the owner when the return type is itself qualified', async () => {
    const nodes = await cppNodes(
      'MACRO level::level_enum logger::level() const { return {}; }\n');
    expect(nodes.filter((n) => n.kind === 'method').map((n) => n.qname)).toEqual(['logger.level']);
  });

  it('keeps a template class as the owner when it really is one', async () => {
    const nodes = await cppNodes('template <class T> int Vec<T>::At(int i) { return i; }\n');
    expect(nodes.filter((n) => n.kind === 'method').map((n) => n.qname)).toEqual(['Vec.At']);
  });

  it('keeps the namespace path of a free function that really is qualified', async () => {
    const nodes = await cppNodes(`namespace a { namespace b { void f(); } }
void a::b::f() { }
`);
    const f = nodes.filter((n) => n.kind === 'method' || n.kind === 'function');
    expect(f.map((n) => n.qname)).toContain('a.b.f');
  });

  it('still names the owner when there is no macro', async () => {
    const nodes = await cppNodes(`class R { };
std::shared_ptr<L> R::get(int a) { return nullptr; }
`);
    expect(nodes.filter((n) => n.kind === 'method').map((n) => n.qname)).toEqual(['R.get']);
  });

  it('answers callers for a method defined behind a macro', async () => {
    write('registry.h', `#pragma once
#include <memory>
class Logger { };
class Registry {
 public:
  std::shared_ptr<Logger> get(int id);
};
`);
    write('registry.cc', `#include "registry.h"
MYLIB_INLINE std::shared_ptr<Logger> Registry::get(int id) { return nullptr; }
`);
    write('use.cc', `#include "registry.h"
void run(Registry& r) { r.get(7); }
`);
    const store = await indexed();
    expect(store.callers('Registry.get').filter((r) => !r.guess).map((r) => r.qname))
      .toEqual(['run']);
  });
});
