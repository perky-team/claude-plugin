import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-filescope-')); });
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

// A call written outside any function has no enclosing symbol, so its edge holds
// `src_id = NULL` and the inner join in `callers` could never report it. It was
// reported instead in the gap banner, one line per call — and that banner is
// capped at 20 rows. Measured on hugo: `parse.mkItem` has 120 such call sites, 20
// were named and 100 were replaced by "… and 100 more". Across axios, nest, got
// and hugo, 13 symbols are over the cap and 1,500 rows are never named.
describe('a call written at file scope gets a caller row', () => {
  beforeEach(() => {
    write('lib/manager.js', `export class Manager {
  eject(id) { return id; }
}
`);
    write('app/boot.js', `import { Manager } from '../lib/manager.js';
const m = new Manager();
m.eject(1);
m.eject(2);
`);
  });

  it('lists the file, once, with every call site on it', async () => {
    const store = await indexed();

    const rows = store.callers('Manager.eject');
    const fileRows = rows.filter((r) => r.kind === 'file');
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0].qname).toBe('app/boot.js');
    expect(fileRows[0].call_sites.map((s) => s.line)).toEqual([3, 4]);
    store.close();
  }, 30000);

  it('keeps ordinary callers too, and puts them first', async () => {
    write('app/run.js', `import { Manager } from '../lib/manager.js';
export function run(m) { return m.eject(3); }
`);
    const store = await indexed();

    const kinds = store.callers('Manager.eject').map((r) => r.kind);
    expect(kinds).toContain('function');
    expect(kinds).toContain('file');
    expect(kinds.indexOf('file')).toBe(kinds.length - 1);
    store.close();
  }, 30000);

  // A row the resolver never tied to this symbol is not a call site of it. Only a
  // RESOLVED edge counts — the same rule the rest of `callers` follows.
  it('does not invent a row for an unresolved call', async () => {
    // `new Manager()` in the shared boot.js above ties `m` to Manager by
    // construction, so it resolves on its own — a second `eject` elsewhere would
    // not change that. To make the call genuinely unresolved, boot.js is
    // overwritten here so `m` comes from an untyped call instead. With no known
    // type for `m`, resolution falls back to a bare `eject` lookup, and with two
    // classes now defining it, that lookup is not unique and refuses.
    write('app/boot.js', `import { getThing } from '../lib/factory.js';
const m = getThing();
m.eject(1);
m.eject(2);
`);
    write('lib/factory.js', `export function getThing() { return {}; }
`);
    write('lib/other.js', `export class Other {
  eject(id) { return id; }
}
`);
    const store = await indexed();

    // Two definitions share the name, so the fallback refuses and nothing at file
    // scope resolves to either one.
    const fileRows = store.callers('Manager.eject').filter((r) => r.kind === 'file');
    expect(fileRows).toHaveLength(0);
    store.close();
  }, 30000);

  it('says whether the row rests on a guess', async () => {
    const store = await indexed();

    const fileRow = store.callers('Manager.eject').find((r) => r.kind === 'file');
    expect(fileRow.guess).toBeTypeOf('number');
    store.close();
  }, 30000);
});
