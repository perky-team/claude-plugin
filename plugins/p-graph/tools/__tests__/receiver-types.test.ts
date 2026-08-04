import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-recv-')); });
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

describe('Go parameter and variable types', () => {
  it('resolves a call on a parameter to that parameter type', async () => {
    write('store/pg.go', `package store
type Postgres struct{}
func (p *Postgres) Get(id string) string { return "" }
type Memory struct{}
func (m *Memory) Get(id string) string { return "" }
`);
    write('api/api.go', `package api
import "x/store"
func Read(db *store.Postgres) string { return db.Get("1") }
`);
    const store = await indexed();

    // Two types have Get, so before this task the call was an unresolved gap.
    expect(store.callers('store.Postgres.Get').map((n) => n.qname)).toEqual(['api.Read']);
    expect(store.callers('store.Memory.Get')).toEqual([]);

    store.close();
  }, 30000);

  it('refuses a call on a parameter whose type lives outside the repo', async () => {
    write('logs/logs.go', `package logs
type Adapter struct{}
func (a *Adapter) Errorf(f string, v ...any) {}
`);
    write('far/far_test.go', `package far
import "testing"
func TestA(t *testing.T) { t.Errorf("boom") }
`);
    const store = await indexed();

    // testing.T is not a repo type, so this call leaves the repo. Linking it to
    // the one repo method named Errorf is the false edge this task removes.
    expect(store.callers('logs.Adapter.Errorf')).toEqual([]);
    // And it must not vanish in silence.
    expect(store.gapsFor('logs.Adapter.Errorf').length).toBeGreaterThan(0);

    store.close();
  }, 30000);

  it('types a local variable declared with var or built from a composite literal', async () => {
    write('store/pg.go', `package store
type Postgres struct{}
func (p *Postgres) Get(id string) string { return "" }
type Memory struct{}
func (m *Memory) Get(id string) string { return "" }
`);
    write('api/api.go', `package api
import "x/store"
func FromVar() string {
	var db store.Postgres
	return db.Get("1")
}
func FromLiteral() string {
	db := &store.Postgres{}
	return db.Get("1")
}
func FromNew() string {
	db := new(store.Memory)
	return db.Get("1")
}
`);
    const store = await indexed();

    expect(store.callers('store.Postgres.Get').map((n) => n.qname).sort())
      .toEqual(['api.FromLiteral', 'api.FromVar']);
    expect(store.callers('store.Memory.Get').map((n) => n.qname)).toEqual(['api.FromNew']);

    store.close();
  }, 30000);

  it('refuses a local whose type it cannot see, and says so', async () => {
    write('io2/io2.go', `package io2
type Counter struct{}
func (c *Counter) WriteRune(r rune) {}
`);
    write('use/use.go', `package use
import "strings"
func Build() string {
	var sb strings.Builder
	sb.WriteRune('x')
	return sb.String()
}
`);
    const store = await indexed();

    expect(store.callers('io2.Counter.WriteRune')).toEqual([]);
    expect(store.gapsFor('io2.Counter.WriteRune').length).toBeGreaterThan(0);

    store.close();
  }, 30000);

  it('leaves a variable it cannot type alone rather than guessing', async () => {
    write('svc/svc.go', `package svc
type A struct{}
func (a *A) Run() {}
func Make() *A { return &A{} }
func Use() {
	x := Make()
	x.Run()
}
`);
    const store = await indexed();

    // The type comes from a function's return value, which this task does not
    // read. The bare name Run is unique here, so the old fallback still links it
    // — that is allowed. What must NOT happen is a wrong link.
    const callers = store.callers('svc.A.Run').map((n) => n.qname);
    expect(callers.every((q) => q === 'svc.Use')).toBe(true);

    store.close();
  }, 30000);

  it('types a package-level variable, and reads it from another file', async () => {
    write('pool/pool.go', `package pool
type Keeper struct{}
func (k *Keeper) Put(v string) {}
`);
    // The pool is declared in one file of the package and used in another. The type
    // has to travel across files, the same way a struct field type already does.
    write('use/vars.go', `package use
import "x/pool"
var keeper = &pool.Keeper{}
`);
    write('use/use.go', `package use
func Store() { keeper.Put("a") }
`);
    const store = await indexed();

    expect(store.callers('pool.Keeper.Put').map((n) => n.qname)).toEqual(['use.Store']);

    store.close();
  }, 30000);

  it('refuses an external package-level type, which is where sync.Pool.Put came from', async () => {
    write('goldmark/autoid.go', `package goldmark
type idFactory struct{}
func (ids *idFactory) Put(value []byte) {}
`);
    write('bufferpool/bufpool.go', `package bufferpool
import "sync"
var bufferPool = &sync.Pool{}
func PutBuffer(buf []byte) { bufferPool.Put(buf) }
`);
    const store = await indexed();

    // This exact shape gave goldmark.idFactory.Put 12 callers on hugo, where gopls
    // finds none: every one was a sync.Pool.Put matched by bare name.
    expect(store.callers('goldmark.idFactory.Put')).toEqual([]);
    expect(store.gapsFor('goldmark.idFactory.Put').length).toBeGreaterThan(0);

    store.close();
  }, 30000);

  it('lets a name declared in the function hide a package-level one', async () => {
    write('svc/pkg.go', `package svc
type Keeper struct{}
func (k *Keeper) Run() {}
type Other struct{}
func (o *Other) Run() {}
var item = &Keeper{}
`);
    // The range variable shares its name with the package-level var. We cannot say
    // what a range variable holds, so this call must stay a guess — it must not be
    // answered with the package-level type.
    write('svc/loop.go', `package svc
func Loop(items []*Other) {
	for _, item := range items {
		item.Run()
	}
}
`);
    const store = await indexed();

    expect(store.callers('svc.Keeper.Run')).toEqual([]);
    expect(store.gapsFor('svc.Keeper.Run').length).toBeGreaterThan(0);

    store.close();
  }, 30000);

  it('counts a name declared by a two-value assignment as declared', async () => {
    write('svc/pkg.go', `package svc
type Keeper struct{}
func (k *Keeper) Run() {}
type Other struct{}
func (o *Other) Run() {}
func makeOther() (*Other, error) { return nil, nil }
var item = &Keeper{}
`);
    // `item, err := makeOther()` has two names and one value, so there is no type
    // to read for `item`. The name is still declared here, and the package-level
    // `item` must not be allowed to answer the call.
    write('svc/use.go', `package svc
func Use() error {
	item, err := makeOther()
	item.Run()
	return err
}
`);
    const store = await indexed();

    expect(store.callers('svc.Keeper.Run')).toEqual([]);
    expect(store.gapsFor('svc.Keeper.Run').length).toBeGreaterThan(0);

    store.close();
  }, 30000);

  it('reaches a field of a typed parameter', async () => {
    write('buf/buf.go', `package buf
type Sink struct{}
func (s *Sink) WriteRune(r rune) {}
type Writer struct {
	buff *Sink
}
type Decoy struct{}
func (d *Decoy) WriteRune(r rune) {}
`);
    // `w` is a parameter, not the enclosing receiver, so the type of `w.buff` is
    // only known once we know the type of `w`. This is the shape hugo writes as
    // w.buff.WriteRune(...), where the bare name pulled in a strings.Builder.
    write('lex/lex.go', `package lex
import "x/buf"
func Lex(w *buf.Writer) { w.buff.WriteRune('x') }
`);
    const store = await indexed();

    expect(store.callers('buf.Sink.WriteRune').map((n) => n.qname)).toEqual(['lex.Lex']);
    expect(store.callers('buf.Decoy.WriteRune')).toEqual([]);

    store.close();
  }, 30000);

  // Build tags are how one variable really does hold two types. Only one of the
  // two files below compiles on any given platform, but the index reads both, so
  // the package-level name `store` carries two recorded types at once. Pass F
  // must refuse the key instead of answering with whichever type it reads first
  // — that would be a CERTAIN row naming the wrong platform's type.
  it('refuses a variable that two files give different types', async () => {
    write('svc/types.go', `package svc
type Postgres struct{}
func (p *Postgres) Get(id string) string { return "" }
type Memory struct{}
func (m *Memory) Get(id string) string { return "" }
`);
    write('svc/store_linux.go', `//go:build linux
package svc
var store = &Postgres{}
`);
    write('svc/store_windows.go', `//go:build windows
package svc
var store = &Memory{}
`);
    write('svc/use.go', `package svc
func Read() string { return store.Get("1") }
`);
    const s = await indexed();

    // Neither type may claim the call...
    expect(s.callers('svc.Postgres.Get')).toEqual([]);
    expect(s.callers('svc.Memory.Get')).toEqual([]);
    // ...and it must not vanish in silence.
    expect(s.gapsFor('svc.Postgres.Get').length).toBeGreaterThan(0);

    s.close();
  }, 30000);
});
