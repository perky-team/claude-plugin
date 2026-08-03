import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-unres-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(rel, src) {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
}

// Fixture in the shape that made the graph lie: one method name on two types,
// reached through an interface field, an interface parameter and a local variable.
// The local variable states its type, so that call site resolves. The two
// interface shapes cannot supply a target — which implementation runs is a
// runtime decision — so those call sites stay unresolved, and the graph must SAY
// so instead of answering "no callers".
function writeAmbiguousFixture() {
  write('internal/store/store.go', `package store
type Store interface {
	ListGroups() []string
}
`);
  write('internal/store/pg.go', `package store
type Postgres struct{}
func (p *Postgres) ListGroups() []string { return nil }
`);
  write('internal/store/mem.go', `package store
type Memory struct{}
func (m *Memory) ListGroups() []string { return nil }
`);
  // Call sites at lines 7 (interface field), 8 (concrete field — resolves),
  // 9 (parameter) and 12 (local variable).
  write('internal/api/server.go', `package api
import "x/internal/store"
type Server struct {
	store store.Store
	pg    *store.Postgres
}
func (s *Server) HandleList() []string { return s.store.ListGroups() }
func (s *Server) HandleTyped() []string { return s.pg.ListGroups() }
func Serve(st store.Store) []string { return st.ListGroups() }
func ServeLocal() []string {
	p := &store.Postgres{}
	return p.ListGroups()
}
`);
  // A second layer: HandleTyped is itself called through an interface field and
  // its name is ambiguous, so the call at line 7 is where an impact walk stops.
  write('internal/http/router.go', `package http
type Handler interface {
	HandleTyped() []string
}
type Other struct{}
func (o *Other) HandleTyped() []string { return nil }
type Router struct { srv Handler }
func (r *Router) Route() []string { return r.srv.HandleTyped() }
`);
}

describe('unresolved call-site reporting', () => {
  it('counts call edges and unresolved ones in status', async () => {
    writeAmbiguousFixture();
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    const st = store.status();
    // 4 ListGroups call sites + 1 HandleTyped call site. Two can be typed: the
    // concrete field (s.pg.ListGroups) and the local variable (p.ListGroups).
    // The two interface receivers cannot.
    expect(st.call_edges).toBe(5);
    expect(st.unresolved_calls).toBe(3);

    store.close();
  }, 30000);

  it('lists the ambiguous call sites that name a target', async () => {
    writeAmbiguousFixture();
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // Asking by qname must still surface the call sites left bare: they carry
    // the target's bare name, which is exactly why they could not be attributed.
    const rows = store.gapsFor('store.Postgres.ListGroups');
    // Line 12 (the local variable) is absent: it resolves now, so it is an answer
    // rather than a gap. Lines 7 and 9 are the two interface receivers.
    expect(rows.map((r) => `${r.file}:${r.line}`)).toEqual([
      'internal/api/server.go:7',
      'internal/api/server.go:9',
    ]);
    expect(rows[0].src_qname).toBe('api.Server.HandleList');
    expect(rows[0].dst_name).toBe('ListGroups');
    // The bare name works too — that is what a user usually types.
    expect(store.gapsFor('ListGroups')).toHaveLength(2);
    // A symbol nothing calls ambiguously reports nothing.
    expect(store.gapsFor('api.Serve')).toEqual([]);

    store.close();
  }, 30000);

  it('lists the unresolved calls a symbol makes', async () => {
    writeAmbiguousFixture();
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    const rows = store.gapsFrom('api.Server.HandleList');
    expect(rows).toHaveLength(1);
    expect(rows[0].dst_name).toBe('ListGroups');
    expect(rows[0].line).toBe(7);
    // The call that resolved is not reported as a gap.
    expect(store.gapsFrom('api.Server.HandleTyped')).toEqual([]);

    store.close();
  }, 30000);

  it('reports the gaps at the frontier of an impact set, not just at the target', async () => {
    writeAmbiguousFixture();
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // impact() walks resolved edges only: it reaches the two call sites it can
    // type and stops at HandleTyped, whose own caller is an unresolved interface
    // call.
    expect(store.impact('store.Postgres.ListGroups').map((n) => n.qname).sort())
      .toEqual(['api.ServeLocal', 'api.Server.HandleTyped']);
    // The frontier report must include BOTH the target's own bare call sites and
    // the one where the walk stopped one level up.
    const rows = store.gapsAround('store.Postgres.ListGroups');
    expect(rows.map((r) => `${r.file}:${r.line}`)).toEqual([
      'internal/api/server.go:7',
      'internal/api/server.go:9',
      'internal/http/router.go:8',
    ]);

    store.close();
  }, 30000);
});

// Fixture with the shapes that hide from a name-keyed report: a failed
// own-receiver guess, and a call site outside any indexed symbol. It also holds a
// local variable that shadows an imported package — that one used to hide here
// too, and the first test below pins down that it no longer has to.
function writeHidingFixture() {
  write('internal/config/config.go', `package config
func Load() {}
`);
  // `Do` shadows the imported package inside a block and calls the real package
  // outside it, so "the shadow took nothing from the package" is a claim with
  // something to prove.
  write('internal/related/related.go', `package related
import "x/internal/config"
type IndexConfig struct{}
func (c IndexConfig) ToKeywords() {}
func Do() {
	if true {
		config := IndexConfig{}
		config.ToKeywords()
	}
	config.Load()
}
`);
  write('internal/emb/emb.go', `package emb
type Base struct{}
func (b *Base) Get() string { return "" }
type Wrap struct{ Base }
func (w *Wrap) Do() string { return w.Get() }
`);
  write('internal/rival/rival.go', `package rival
type Rival struct{}
func (r *Rival) Get() string { return "" }
`);
  write('web/boot.ts', `import { Engine } from './engine';
const e = new Engine();
e.start();
`);
  // Motor's method has a different name from Engine's on purpose: if both were
  // "start", the bare name would not be unique, and the store's own bare-name
  // fallback (Pass B) would leave the call unresolved instead of the resolved,
  // caller-less edge this fixture needs.
  write('web/engine.ts', `export class Engine { start() {} }
export class Motor { spin() {} }
`);
}

describe('the gap report finds gaps recorded under another name', () => {
  it('answers a call on a local that shadows a package instead of reporting a gap', async () => {
    writeHidingFixture();
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // This call used to be recorded as "config.ToKeywords" — the local variable
    // `config` was read as the imported package of the same name, so the method
    // got no caller and the gap report had to carry it. The variable's own type is
    // read first now, so it is a real answer and there is nothing left to report.
    expect(store.callers('related.IndexConfig.ToKeywords').map((n) => n.qname)).toEqual(['related.Do']);
    const rows = store.gapsFor('related.IndexConfig.ToKeywords');
    expect(rows.filter((r) => r.file === 'internal/related/related.go')).toEqual([]);
    // The shadow ends with its block, so the call below it still reaches the
    // package. Without this the assertion above would pass even if the shadow had
    // swallowed every call on that name in the function.
    expect(store.callers('config.Load').map((n) => n.qname)).toEqual(['related.Do']);
    store.close();
  }, 30000);

  it('reports a failed own-receiver guess for a promoted method', async () => {
    writeHidingFixture();
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // emb.Wrap embeds a repo type, so Pass C links it. Break that by making the
    // embedded type external-only, leaving a gap recorded as "emb.Wrap.Get".
    write('internal/emb/emb.go', `package emb
import "sync"
type Wrap struct{ sync.Mutex }
func (w *Wrap) Do() string { return w.Get() }
`);
    await indexFull({ root: dir, store, ignorePatterns: [] });

    const rows = store.gapsFor('rival.Rival.Get');
    const row = rows.find((r) => r.file === 'internal/emb/emb.go');
    expect(row).toBeTruthy();
    expect(row.dst_name).toBe('emb.Wrap.Get');
    expect(row.reason).toBe('ambiguous');
    store.close();
  }, 30000);

  it('reports a resolved call site that sits outside any indexed symbol', async () => {
    writeHidingFixture();
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // `e.start()` is at module scope in boot.ts: resolved, but callers() cannot
    // show a caller row for it.
    expect(store.callers('Engine.start')).toEqual([]);
    const rows = store.gapsFor('Engine.start');
    const row = rows.find((r) => r.file === 'web/boot.ts');
    expect(row).toBeTruthy();
    expect(row.reason).toBe('no-caller');
    store.close();
  }, 30000);

  it('separates calls that leave the repo from calls that may have a target here', async () => {
    write('a/a.go', `package a
import "fmt"
type T struct{}
func (t *T) Do() { fmt.Println("x"); _ = len("y") }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    const rows = store.gapsFrom('a.T.Do');
    const reasons = rows.map((r) => r.reason).sort();
    // fmt.Println has no repo candidate; len is a builtin marked external.
    expect(reasons).toEqual(['external', 'external']);
    store.close();
  }, 30000);

  it('flags a same-name gap in a file that cannot see the target package', async () => {
    write('logs/logs.go', `package logs
type Adapter struct{}
func (a *Adapter) Errorf(f string, v ...any) {}
`);
    // A second, unrelated Errorf keeps the bare name from being repo-unique —
    // otherwise the store's own bare-name fallback would resolve the call
    // outright instead of leaving it as an ambiguous gap.
    write('logs2/logs2.go', `package logs2
type Adapter struct{}
func (a *Adapter) Errorf(f string, v ...any) {}
`);
    write('far/far_test.go', `package far
import "testing"
func TestX(t *testing.T) { t.Errorf("boom") }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    const rows = store.gapsFor('logs.Adapter.Errorf');
    const row = rows.find((r) => r.file === 'far/far_test.go');
    expect(row).toBeTruthy();
    expect(row.reachable).toBe(0); // far/ never imports logs/
    // A bare dst_name ("Errorf", from t.Errorf()) carries no qualifier, so the
    // qualifier rule below does not touch it — it stays classified on bare-name
    // candidates alone, same as before that rule existed.
    expect(row.reason).toBe('ambiguous');
    store.close();
  }, 30000);

  // The bug: a gap was matched and classified by bare name only. "fmt.Errorf"
  // and a repo method "logs.Adapter.Errorf" share the bare name "Errorf", so the
  // old code called fmt.Errorf "ambiguous" — as if the repo method might be the
  // real target. It cannot be: the call site wrote the qualifier "fmt", and no
  // repo package is named "fmt". A qualified name can only ever name a symbol in
  // the package its qualifier points to.
  it('classifies a qualified call as external when its qualifier is not a repo package', async () => {
    write('logs/logs.go', `package logs
type Adapter struct{}
func (a *Adapter) Errorf(f string, v ...any) {}
`);
    // A second repo method named Errorf: proof that "external" comes from the
    // qualifier check, not merely from the bare name being repo-unique.
    write('other/other.go', `package other
type Thing struct{}
func (t *Thing) Errorf(f string, v ...any) {}
`);
    write('caller/caller.go', `package caller
import "fmt"
func Do() { fmt.Errorf("x") }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    const rows = store.gapsFor('logs.Adapter.Errorf');
    const row = rows.find((r) => r.file === 'caller/caller.go');
    expect(row).toBeTruthy();
    expect(row.dst_name).toBe('fmt.Errorf');
    expect(row.reason).toBe('external');

    // gapsFrom classifies with its own SQL — it must agree with gapsFor.
    const fromRows = store.gapsFrom('caller.Do');
    expect(fromRows).toHaveLength(1);
    expect(fromRows[0].dst_name).toBe('fmt.Errorf');
    expect(fromRows[0].reason).toBe('external');

    store.close();
  }, 30000);
});
