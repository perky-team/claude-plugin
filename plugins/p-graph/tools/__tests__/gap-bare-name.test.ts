import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-bare-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};

describe('a bare-name query keeps the gap report', () => {
  it('reports the same no-caller rows whether asked by qname or by bare name', async () => {
    // `start` is called at module scope, so the call resolves but has no caller
    // symbol — exactly the row `callers` cannot show and the banner must.
    write('web/engine.ts', 'export class Engine { start() {} }');
    write('web/boot.ts', "import { Engine } from './engine';\nnew Engine().start();");
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    const byQname = store.gapsFor('Engine.start');
    expect(byQname.filter((r) => r.reason === 'no-caller')).toHaveLength(1);

    // `store.callers('start')` finds the symbol by bare name, so the gap report
    // must find it too. Before this fix it returned nothing.
    expect(store.callers('start').length).toBe(store.callers('Engine.start').length);
    const byName = store.gapsFor('start');
    expect(byName.filter((r) => r.reason === 'no-caller')).toHaveLength(1);
    expect(byName.map((r) => `${r.file}:${r.line}`))
      .toEqual(byQname.map((r) => `${r.file}:${r.line}`));

    store.close();
  }, 30000);

  it('collects no-caller rows from every symbol a bare name matches', async () => {
    // Two package-level Go funcs named "Run", called by their qualified name
    // ("pkga.Run", "pkgb.Run") from a package-scope var initializer — no
    // enclosing func, so each call resolves but has no caller symbol. A TS
    // `this`-free method call (`new A().run()`) cannot make this shape: TS/JS
    // only qualifies a call when it is written as `this.m()` inside a method,
    // and that always has a caller, so it can never produce a no-caller row
    // for two different, same-named targets. Go's package qualifier gives two
    // independently resolved, caller-less calls that still share a bare name.
    write('pkga/pkga.go', 'package pkga\nfunc Run() {}\n');
    write('pkgb/pkgb.go', 'package pkgb\nfunc Run() {}\n');
    write('caller_a/caller_a.go', 'package callera\nimport "x/pkga"\nvar _ = pkga.Run()\n');
    write('caller_b/caller_b.go', 'package callerb\nimport "x/pkgb"\nvar _ = pkgb.Run()\n');
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // Both pkga.Run and pkgb.Run are called at package scope. Asking by the
    // shared bare name must report both call sites, not one and not none.
    const rows = store.gapsFor('Run').filter((r) => r.reason === 'no-caller');
    expect(rows.map((r) => r.file).sort()).toEqual(['caller_a/caller_a.go', 'caller_b/caller_b.go']);

    store.close();
  }, 30000);

  it('keeps a same-name gap reachable when the bare name matches symbols in two packages', async () => {
    // "Bar" lives on foo.X and on baz.Y. call.go imports foo, not baz, and calls
    // Bar on a field of a third-party type, so the call stays ambiguous: the source
    // states a type, which refuses the bare-name fallback, and no repo symbol
    // carries it. (An interface field used to do this job; an interface method is a
    // symbol now, so the call would land on it and this test would be measuring
    // nothing.) Asked by the bare
    // name "Bar", both foo.X.Bar and baz.Y.Bar match — one whose package call.go
    // can reach, one it cannot. Scoring the row against only one of them (which
    // symbol happens to be checked first is an implementation detail, not
    // something a user should have to know about) could wrongly report
    // reachable: 0 half the time. A row that matched more than one symbol must
    // stay reachable: 1 — a possible real miss must not be demoted just because
    // an unrelated namesake in another package also matched.
    write('foo/foo.go', `package foo
type X struct{}
func (x *X) Bar() {}
`);
    write('baz/baz.go', `package baz
type Y struct{}
func (y *Y) Bar() {}
`);
    write('call/call.go', `package call
import "x/foo"
import "github.com/third/ext"
type C struct { v ext.Thing }
func (c *C) Do() { c.v.Bar() }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    const rows = store.gapsFor('Bar');
    const row = rows.find((r) => r.file === 'call/call.go');
    expect(row).toBeTruthy();
    expect(row.reason).toBe('library');
    expect(row.reachable).toBe(1);

    store.close();
  }, 30000);
});
