import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-false-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};
async function indexed() {
  const store = openStore(':memory:');
  await indexFull({ root: dir, store, ignorePatterns: [] });
  return store;
}

// Each case below is a false edge the evaluation found in hugo, shrunk to the
// smallest source that reproduces it.
describe('the resolver refuses links it cannot justify', () => {
  it('never links a Go builtin call to a same-named method', async () => {
    write('exec/exec.go', `package exec
type E struct{ a []int; b []int }
func (e *E) Run() { copy(e.b, e.a) }
`);
    write('tpl/tpl.go', `package tpl
type Template struct{}
func (t *Template) copy() {}
`);
    const store = await indexed();
    expect(store.callers('tpl.Template.copy')).toEqual([]);
    store.close();
  }, 30000);

  it('never links a call across languages', async () => {
    write('live/live.js', 'function boot(result, key) { result.push(key); }');
    write('tpl/tpl.go', `package tpl
type state struct{}
func (s *state) push() {}
`);
    const store = await indexed();
    expect(store.callers('tpl.state.push')).toEqual([]);
    store.close();
  }, 30000);

  it('never links a call to a type or a struct', async () => {
    write('cfg/cfg.go', `package cfg
type Duration int64
func Parse(v int64) Duration { return Duration(v) }
`);
    const store = await indexed();
    expect(store.callers('cfg.Duration')).toEqual([]);
    store.close();
  }, 30000);

  it('never falls back to a bare name when the receiver field has a known external type', async () => {
    write('goldmark/autoid.go', `package goldmark
import "bytes"
type W struct{ buf bytes.Buffer }
func (w *W) Do() { w.buf.WriteRune('-') }
`);
    write('highlight/highlight.go', `package highlight
type counter struct{}
func (c *counter) WriteRune(r rune) {}
`);
    const store = await indexed();
    // bytes.Buffer is not a repo type, so this call leaves the repo. Linking it
    // to the one repo method that happens to be called WriteRune is a lie.
    expect(store.callers('highlight.counter.WriteRune')).toEqual([]);
    store.close();
  }, 30000);

  it('never treats a func-typed field as a promoted method', async () => {
    write('filecache/filecache.go', `package filecache
type L struct{ unlock func() }
func (l *L) Do() { l.unlock() }
`);
    write('doctree/doctree.go', `package doctree
type T struct{}
func (t *T) unlock() {}
`);
    const store = await indexed();
    expect(store.callers('doctree.T.unlock')).toEqual([]);
    store.close();
  }, 30000);

  it('never treats a method of an embedded external type as a repo method', async () => {
    write('svc/svc.go', `package svc
import "sync"
type S struct{ sync.Mutex }
func (s *S) Do() { s.Lock() }
`);
    write('other/other.go', `package other
type Gate struct{}
func (g *Gate) Lock() {}
`);
    const store = await indexed();
    expect(store.callers('other.Gate.Lock')).toEqual([]);
    store.close();
  }, 30000);

  it('still links a method promoted from an embedded repo type', async () => {
    write('base/base.go', `package base
type Base struct{}
func (b *Base) Shared() {}
`);
    write('wrap/wrap.go', `package wrap
import "x/base"
type Wrap struct{ base.Base }
func (w *Wrap) Do() { w.Shared() }
`);
    const store = await indexed();
    expect(store.callers('base.Base.Shared').map((n) => n.qname)).toEqual(['wrap.Wrap.Do']);
    store.close();
  }, 30000);

  it('never falls back to a bare name when the receiver field has a repo-defined interface type', async () => {
    write('store/store.go', `package store
type Store interface {
	ListGroups()
}
`);
    write('api/server.go', `package api
import "x/store"
type Server struct {
	s store.Store
}
func (srv *Server) HandleList() { srv.s.ListGroups() }
`);
    write('pg/pg.go', `package pg
type Postgres struct{}
func (p *Postgres) ListGroups() {}
`);
    const store = await indexed();
    // store.Store is a repo type, so the interface node exists and the OLD guard
    // ("type is known and is not a repo type") let this through. But an
    // interface's methods are signatures, not method_declaration nodes, and
    // store.Store embeds nothing — there is no legitimate target for this call,
    // so it must stay unresolved rather than land on the one unrelated method
    // that happens to share the bare name "ListGroups".
    expect(store.callers('pg.Postgres.ListGroups')).toEqual([]);
    store.close();
  }, 30000);

  it('still links a method promoted from an embedded repo type, reached through a field', async () => {
    write('core/core.go', `package core
type Base struct{}
func (b *Base) Shared() {}
type Wrap struct{ Base }
`);
    write('app/app.go', `package app
import "x/core"
type App struct {
	dep *core.Wrap
}
func (a *App) Do() { a.dep.Shared() }
`);
    const store = await indexed();
    // dep's type (core.Wrap) has no method "Shared" of its own, but it embeds
    // core.Base, which does. Losing this edge would be a gap, not a fix — the
    // rule must allow the bare-name fallback here even though it now blocks the
    // interface case above.
    expect(store.callers('core.Base.Shared').map((n) => n.qname)).toEqual(['app.App.Do']);
    store.close();
  }, 30000);

  it('resolves a TypeScript "new Service()" call to the class through resolvePending', async () => {
    write('svc.ts', `export class Service {
  run() { return 1; }
}
function boot() { new Service(); }
`);
    const store = await indexed();
    expect(store.callers('Service').map((n) => n.qname)).toEqual(['boot']);
    store.close();
  }, 30000);

  it('never resolves an import edge to a symbol', async () => {
    write('a/a.go', `package a
import "x/b"
func Use() { b.Do() }
`);
    write('b/b.go', `package b
func Do() {}
`);
    const store = await indexed();
    const resolvedImports = store.db.prepare(
      `SELECT count(*) c FROM edges WHERE kind = 'import' AND dst_id IS NOT NULL`).get().c;
    expect(resolvedImports).toBe(0);
    store.close();
  }, 30000);
});
