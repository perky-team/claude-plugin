import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-ret-')); });
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

// `b := hugolib.Test(t, files)` then `b.AssertFileContent(...)`: nothing at the
// call site names a type, so the bare-name fallback answered it — 776 rows on hugo
// for one method, every one a guess. The callee's own signature says what b is.
describe('a receiver typed by a function\'s declared result', () => {
  it('resolves through the result type, and calls it certain', async () => {
    write('store/store.go', `package store
type Conn struct{}
func (c *Conn) Query(q string) string { return "" }
func Open() *Conn { return &Conn{} }
`);
    write('api/api.go', `package api
import "x/store"
func Read() string {
	c := store.Open()
	return c.Query("1")
}
`);
    const s = await indexed();

    expect(s.callers('store.Conn.Query')).toMatchObject([{ qname: 'api.Read', guess: 0 }]);
    s.close();
  }, 30000);

  // The strong version: two types share the method name, so the bare-name
  // fallback cannot answer at all and a guess would have to pick. Only reading
  // Open's result decides it — and it decides it right.
  it('picks the right type where a bare name could not', async () => {
    write('store/store.go', `package store
type Postgres struct{}
func (p *Postgres) Get() string { return "" }
type Memory struct{}
func (m *Memory) Get() string { return "" }
func OpenMemory() *Memory { return &Memory{} }
`);
    write('api/api.go', `package api
import "x/store"
func Read() string {
	db := store.OpenMemory()
	return db.Get()
}
`);
    const s = await indexed();

    expect(s.callers('store.Memory.Get')).toMatchObject([{ qname: 'api.Read', guess: 0 }]);
    expect(s.callers('store.Postgres.Get')).toEqual([]);
    s.close();
  }, 30000);

  it('follows an import alias, the way a call site does', async () => {
    write('bufferpool/bufpool.go', `package bufferpool
type Buffer struct{}
func (b *Buffer) WriteString(s string) {}
func GetBuffer() *Buffer { return &Buffer{} }
`);
    write('tpl/tpl.go', `package tpl
import bp "x/bufferpool"
func Render() {
	b := bp.GetBuffer()
	b.WriteString("x")
}
`);
    const s = await indexed();

    expect(s.callers('bufferpool.Buffer.WriteString')).toMatchObject([{ qname: 'tpl.Render', guess: 0 }]);
    s.close();
  }, 30000);

  // The other half of the same fact: when the callee is OUTSIDE the repo there is
  // no result type to read, and that is exactly when the bare-name fallback used
  // to invent a caller. `reflect.ValueOf(...)` gave one hugo symbol 35 false rows.
  it('refuses to guess when the callee lives outside the repo', async () => {
    write('io2/io2.go', `package io2
type Counter struct{}
func (c *Counter) Kind() string { return "" }
`);
    write('use/use.go', `package use
import "reflect"
func Describe(v any) string {
	rv := reflect.ValueOf(v)
	return rv.Kind().String()
}
`);
    const s = await indexed();

    expect(s.callers('io2.Counter.Kind')).toEqual([]);
    // ...and the call site is named, not dropped in silence.
    expect(s.gapsFor('io2.Counter.Kind').length).toBeGreaterThan(0);
    s.close();
  }, 30000);

  // A call on a value cannot be followed: the receiver's own type is what decides
  // which method runs, and that is the question we were trying to answer. Refusing
  // is right; guessing here is what put a wrong caller in the answer.
  it('does not chain through a method call', async () => {
    write('db/db.go', `package db
type Tx struct{}
func (t *Tx) Commit() {}
type Conn struct{}
func (c *Conn) Begin() *Tx { return &Tx{} }
type Decoy struct{}
func (d *Decoy) Commit() {}
func Open() *Conn { return &Conn{} }
`);
    write('api/api.go', `package api
import "x/db"
func Save() {
	c := db.Open()
	t := c.Begin()
	t.Commit()
}
`);
    const s = await indexed();

    // `c` is known (Open's result), so the call ON c is certain...
    expect(s.callers('db.Conn.Begin')).toMatchObject([{ qname: 'api.Save', guess: 0 }]);
    // ...but `t` comes from a method call, which is not followed, so nothing
    // claims t.Commit() — and neither Commit gets a false caller.
    expect(s.callers('db.Decoy.Commit')).toEqual([]);
    s.close();
  }, 30000);
});
