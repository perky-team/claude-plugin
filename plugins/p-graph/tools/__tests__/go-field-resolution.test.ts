import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull, indexChanged } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-gf-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(rel, src) {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
}

describe('go cross-package method-via-field resolution', () => {
  it('resolves recv.field.Method() across packages, value and pointer receivers', async () => {
    write('internal/core/core.go', `package core
type Core struct{}
func (c Core) Action() { c.checkAction() }
func (c *Core) State() int { return 0 }
func (c Core) checkAction() {}
`);
    write('internal/grpc/events/server.go', `package events
import "x/internal/core"
type Server struct {
	dimpleCore *core.Core
}
func (s Server) DoAction() { s.dimpleCore.Action() }
func (s Server) DoState() int { return s.dimpleCore.State() }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // The reported bug: cross-package method-via-field is now resolved.
    expect(store.callers('core.Core.Action').map((n) => n.qname)).toContain('events.Server.DoAction');
    expect(store.impact('core.Core.Action').map((n) => n.qname)).toContain('events.Server.DoAction');
    // pointer-receiver method reached through a value receiver call site
    expect(store.callers('core.Core.State').map((n) => n.qname)).toContain('events.Server.DoState');

    // Regression guard: intra-package + callees stay correct.
    expect(store.callers('core.Core.checkAction').map((n) => n.qname)).toContain('core.Core.Action');
    expect(store.callees('events.Server.DoAction').map((n) => n.qname)).toContain('core.Core.Action');

    store.close();
  }, 30000);

  it('binds each same-named method to the correct type via its distinct field type (no false edges)', async () => {
    write('a/a.go', `package a
type A struct{}
func (x A) Run() {}
`);
    write('b/b.go', `package b
type B struct{}
func (y B) Run() {}
`);
    write('h/h.go', `package h
import (
	"x/a"
	"x/b"
)
type Host struct {
	one *a.A
	two *b.B
}
func (hh Host) DoOne() { hh.one.Run() }
func (hh Host) DoTwo() { hh.two.Run() }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // Each Run() call resolves to ITS type only — the ambiguous bare name "Run"
    // must not create a cross-type false edge.
    expect(store.callers('a.A.Run').map((n) => n.qname)).toEqual(['h.Host.DoOne']);
    expect(store.callers('b.B.Run').map((n) => n.qname)).toEqual(['h.Host.DoTwo']);

    store.close();
  }, 30000);

  it('re-resolves affected edges when the struct-field-declaring file changes', async () => {
    write('core/core.go', `package core
type Core struct{}
func (c Core) Action() {}
type Other struct{}
func (o Other) Action() {}
`);
    write('svc/svc.go', `package svc
import "x/core"
type Server struct {
	dep *core.Core
}
func (s Server) Do() { s.dep.Action() }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });
    expect(store.callers('core.Core.Action').map((n) => n.qname)).toEqual(['svc.Server.Do']);
    expect(store.callers('core.Other.Action')).toEqual([]);

    // Repoint the field to core.Other; only svc.go changes.
    write('svc/svc.go', `package svc
import "x/core"
type Server struct {
	dep *core.Other
}
func (s Server) Do() { s.dep.Action() }
`);
    await indexChanged({
      root: dir, store, ignorePatterns: [],
      changedFiles: () => ({ modified: ['svc/svc.go'], deleted: [] }),
    });
    // The edge must follow the new field type — no stale edge to Core.Action.
    expect(store.callers('core.Other.Action').map((n) => n.qname)).toEqual(['svc.Server.Do']);
    expect(store.callers('core.Core.Action')).toEqual([]);

    store.close();
  }, 30000);

  it('re-resolves a call edge when the field type changes in ANOTHER file than the call site', async () => {
    write('core/core.go', `package core
type Core struct{}
func (c Core) Action() {}
type Other struct{}
func (o Other) Action() {}
`);
    // Struct declaration and the calling method live in SEPARATE files of the
    // same package — the call edge is in server.go, the field type in types.go.
    write('svc/types.go', `package svc
import "x/core"
type Server struct {
	dep *core.Core
}
`);
    write('svc/server.go', `package svc
func (s Server) Do() { s.dep.Action() }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });
    expect(store.callers('core.Core.Action').map((n) => n.qname)).toEqual(['svc.Server.Do']);

    // Change ONLY types.go (the field type); server.go (the call site) is untouched.
    write('svc/types.go', `package svc
import "x/core"
type Server struct {
	dep *core.Other
}
`);
    await indexChanged({
      root: dir, store, ignorePatterns: [],
      changedFiles: () => ({ modified: ['svc/types.go'], deleted: [] }),
    });
    // Even though server.go wasn't reparsed, its edge must follow the new type.
    expect(store.callers('core.Other.Action').map((n) => n.qname)).toEqual(['svc.Server.Do']);
    expect(store.callers('core.Core.Action')).toEqual([]);

    store.close();
  }, 30000);
});
