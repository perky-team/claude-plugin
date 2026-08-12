import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-graph/tools/pgraph.mjs');
let dir;
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-cppq-'));
  mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });

// A C++ reader writes `WriteBatchInternal::Count`, never `leveldb.WriteBatchInternal.Count`.
// Measured on leveldb and re2: the `::` spelling returned nothing AND printed
// "✓ complete", so the agent did not believe the answer and went hunting for a
// spelling that worked — 3 to 5 tool calls per question against grep's 1.
// See docs/measured-benefit.md.
const SRC = `namespace store {
class PgStore {
 public:
  int Get(int id);
  int Warm(int id) { return Get(id); }
};
int PgStore::Get(int id) { return id; }
}
`;

describe('C++ symbols can be asked for the way C++ writes them', () => {
  beforeEach(() => { write('src/store.cc', SRC); run(['index', '--full']); });

  const callerQnames = (spelling) =>
    JSON.parse(run(['callers', spelling, '--stale-ok', '--json'])).callers.map((c) => c.qname);

  it('accepts Class::Method', () => {
    expect(callerQnames('PgStore::Get')).toEqual(['store.PgStore.Warm']);
  }, 30000);

  it('accepts namespace::Class::Method', () => {
    expect(callerQnames('store::PgStore::Get')).toEqual(['store.PgStore.Warm']);
  }, 30000);

  // The dotted qname and the bare name already worked; they must keep working.
  it('still accepts the full dotted qname and the bare name', () => {
    expect(callerQnames('store.PgStore.Get')).toEqual(['store.PgStore.Warm']);
    expect(callerQnames('Get')).toEqual(['store.PgStore.Warm']);
  }, 30000);

  it('names the target it settled on', () => {
    expect(run(['callers', 'PgStore::Get', '--stale-ok'])).toContain('target: method store.PgStore.Get');
  }, 30000);

  it('callees, node and impact take the same spelling', () => {
    expect(JSON.parse(run(['callees', 'PgStore::Warm', '--stale-ok', '--json'])).callees
      .map((c) => c.qname)).toEqual(['store.PgStore.Get']);
    expect(JSON.parse(run(['node', 'PgStore::Get', '--json'])).qname).toBe('store.PgStore.Get');
    expect(JSON.parse(run(['impact', 'PgStore::Get', '--stale-ok', '--json'])).impact
      .map((c) => c.qname)).toContain('store.PgStore.Warm');
  }, 30000);
});

describe('a query that matches nothing never claims to be complete', () => {
  // The worst answer this tool can give: empty, and confident. On re2,
  // `callers "RE2::Match"` printed "✓ complete — no gaps" while knowing nothing
  // about the symbol at all.
  it('says the symbol is not in the graph instead of "complete"', () => {
    write('src/store.cc', SRC);
    run(['index', '--full']);

    const text = run(['callers', 'NoSuchSymbolAtAll', '--stale-ok']);
    expect(text).not.toContain('✓ complete');
    expect(text).toContain('no symbol named NoSuchSymbolAtAll');
    expect(JSON.parse(run(['callers', 'NoSuchSymbolAtAll', '--stale-ok', '--json'])).complete).toBe(false);
  }, 30000);

  it('callees says it too', () => {
    write('src/store.cc', SRC);
    run(['index', '--full']);

    expect(run(['callees', 'NoSuchSymbolAtAll', '--stale-ok'])).not.toContain('✓ complete');
    expect(JSON.parse(run(['callees', 'NoSuchSymbolAtAll', '--stale-ok', '--json'])).complete).toBe(false);
  }, 30000);

  it('impact says it too', () => {
    write('src/store.cc', SRC);
    run(['index', '--full']);

    expect(run(['impact', 'NoSuchSymbolAtAll', '--stale-ok'])).not.toContain('✓ complete');
    expect(JSON.parse(run(['impact', 'NoSuchSymbolAtAll', '--stale-ok', '--json'])).complete).toBe(false);
  }, 30000);

  // A symbol that IS in the graph and simply has no callers is a different
  // claim, and it must keep saying "complete".
  it('a known symbol with no callers is still complete', () => {
    write('a.ts', 'function lonely() {}\nfunction other() {}');
    run(['index', '--full']);

    expect(run(['callers', 'lonely', '--stale-ok'])).toContain('✓ complete');
  }, 30000);
});

describe('a suffix that fits more than one symbol says so', () => {
  // Measured: in leveldb 1,488 of 1,495 `Class::Method` spellings point at
  // exactly one symbol. The 7 that do not must not be settled by a silent pick.
  it('reports both symbols instead of picking one', () => {
    write('src/a.cc', `namespace one {
class Box { public: int Size() { return 1; } };
}
namespace two {
class Box { public: int Size() { return 2; } };
}
`);
    run(['index', '--full']);

    const text = run(['callers', 'Box::Size', '--stale-ok']);
    expect(text).toContain('2 symbols');
    expect(text).toContain('one.Box.Size');
    expect(text).toContain('two.Box.Size');
  }, 30000);
});

describe('a name that exists literally wins over a suffix reading', () => {
  // `Box::Size` reads as the qname `Box.Size`, which one symbol carries outright
  // while another merely ends with. Taking the query literally is what every
  // other language already does, so the suffix reading has to be the last
  // resort — otherwise asking for a top-level symbol quietly drags in a deeper
  // namesake.
  it('prefers the symbol that carries the qname over one that ends with it', () => {
    write('src/a.cc', `class Box { public: int Size() { return 1; } };
namespace deep {
class Box { public: int Size() { return 2; } };
}
`);
    run(['index', '--full']);

    const targets = JSON.parse(run(['callers', 'Box::Size', '--stale-ok', '--json'])).targets.map((t) => t.qname);
    expect(targets).toEqual(['Box.Size']);
  }, 30000);
});
