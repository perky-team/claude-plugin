import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-gogap-')); });
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
const listed = (store, name) =>
  store.gapsFor(name).filter((g) => g.reason === 'ambiguous').map((g) => `${g.file}:${g.line}`);
// A call the source types as a LIBRARY receiver is still reported, under its own
// reason, but not among the rows the reader is told to go and grep for.
const libraryRows = (store, name) =>
  store.gapsFor(name).filter((g) => g.reason === 'library').map((g) => `${g.file}:${g.line}`);

// The rule TypeScript already had, now for Go: a call whose receiver type the
// SOURCE writes down, and writes down as some other REPO type, is not a missing
// call site of this target. Measured on caddy: three of the eighteen rows in the
// banner of `callers "caddyhttp.Handler.ServeHTTP"` were calls on a concrete
// middleware, which could never have been the target. A library type is a separate
// case and stays — see the first test below for why.
describe('the Go gap report and a receiver whose type is written down', () => {
  // A call on a LIBRARY type stays in the report. That is deliberate and it is
  // tested elsewhere too ("refuses a call on a parameter whose type lives outside
  // the repo"): the graph refused to guess and says so. It is also the one case
  // where a repo type could still be behind the value at run time, through an
  // interface whose method set this reader cannot see.
  it('keeps a call on a third-party type', async () => {
    write('foo/foo.go', `package foo
type X struct{}
func (x *X) Bar() {}
`);
    write('baz/baz.go', `package baz
type Y struct{}
func (y *Y) Bar() {}
`);
    write('call/call.go', `package call
import "github.com/third/ext"
type C struct { v ext.Thing }
func (c *C) Do() { c.v.Bar() }
`);
    const store = await indexed();

    // Reported — the promise — but as a counted line, not a place to search.
    expect(libraryRows(store, 'foo.X.Bar')).toEqual(['call/call.go:4']);
    expect(listed(store, 'foo.X.Bar')).toEqual([]);
    store.close();
  }, 30000);

  it('leaves out a call on a different repo type', async () => {
    write('foo/foo.go', `package foo
type X struct{}
func (x *X) Bar() {}
`);
    write('baz/baz.go', `package baz
type Y struct{}
func (y *Y) Bar() {}
type Z struct{}
func (z *Z) Bar() {}
`);
    // Two Bar methods live in baz, so a call on a baz.Y cannot be resolved by
    // bare name — but the source says the receiver is a baz.Y, so it is certainly
    // not foo.X.Bar.
    write('call/call.go', `package call
import "x/baz"
func Do(y *baz.Y, z *baz.Z) { y.Bar(); z.Bar() }
`);
    const store = await indexed();

    expect(listed(store, 'foo.X.Bar')).toEqual([]);
    store.close();
  }, 30000);

  // The rule must not hide a real miss: when the written type IS the target's own,
  // the row stays. Two directories both declaring `package foo` is what makes the
  // call unresolvable while the written type is perfectly clear — hugo has exactly
  // this, twice over.
  it('keeps a call on the target type itself', async () => {
    write('one/foo.go', `package foo
type X struct{}
func (x *X) Bar() {}
`);
    write('two/foo.go', `package foo
type X struct{}
func (x *X) Bar() {}
`);
    write('call/call.go', `package call
import "x/one"
func Do(x *foo.X) { x.Bar() }
`);
    const store = await indexed();

    expect(listed(store, 'foo.X.Bar')).toEqual(['call/call.go:3']);
    store.close();
  }, 30000);

  // A promoted method is a real target for a call on the outer type, so a row whose
  // written type EMBEDS the target's type has to stay.
  it('keeps a call on a type that embeds the target type', async () => {
    write('emb/emb.go', `package emb
type Base struct{}
func (b *Base) Bar() {}
type Wrap struct{ Base }
type Other struct{}
func (o *Other) Bar() {}
`);
    write('call/call.go', `package call
import "x/emb"
func Do(w *emb.Wrap) { w.Bar() }
`);
    const store = await indexed();

    expect(store.gapsFor('emb.Base.Bar').map((g) => `${g.file}:${g.line}`))
      .toContain('call/call.go:3');
    store.close();
  }, 30000);

  // Nothing is written about the receiver, so nothing can be ruled out.
  it('keeps a call whose receiver type is unknown', async () => {
    write('foo/a.go', `package foo
type X struct{}
func (x *X) Bar() {}
type W struct{}
func (w *W) Bar() {}
`);
    write('call/call.go', `package call
import "github.com/third/ext"
func Do() {
	v := ext.New()
	v.Bar()
}
`);
    const store = await indexed();

    expect(listed(store, 'foo.X.Bar')).toEqual(['call/call.go:5']);
    store.close();
  }, 30000);
});
