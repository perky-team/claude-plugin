import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-goalias-')); });
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
const certain = (store, qname) => store.callers(qname).filter((r) => !r.guess).map((r) => r.qname);

// `nextCopy := next` — one name copied into another. Nothing at the second name
// says what it holds, but the first one does, and Go itself reads it that way.
// Measured on caddy: three of the eleven call sites the graph still could not place
// on `Handler.ServeHTTP` were this, all in routes.go, plus two more in tests.
describe('a Go name copied from another name', () => {
  it('takes the type of the name it was copied from', async () => {
    write('h/h.go', `package h
type Handler interface {
	Serve() error
}
func Wrap(next Handler) error {
	copy := next
	return copy.Serve()
}
`);
    const store = await indexed();

    expect(certain(store, 'h.Handler.Serve')).toEqual(['h.Wrap']);
    store.close();
  }, 30000);

  it('follows a concrete type the same way', async () => {
    write('h/h.go', `package h
type Impl struct{}
func (i *Impl) Serve() error { return nil }
func Wrap(next *Impl) error {
	copy := next
	return copy.Serve()
}
`);
    const store = await indexed();

    expect(certain(store, 'h.Impl.Serve')).toEqual(['h.Wrap']);
    store.close();
  }, 30000);

  // The copy is a NEW binding, so a name declared later must not reach back and
  // type an earlier one, and the innermost binding still wins.
  it('reads the binding in scope where the copy is written', async () => {
    write('h/h.go', `package h
type A struct{}
func (a *A) Serve() error { return nil }
type B struct{}
func (b *B) Serve() error { return nil }
func Wrap(next *A) error {
	if true {
		next := &B{}
		copy := next
		return copy.Serve()
	}
	return nil
}
`);
    const store = await indexed();

    expect(certain(store, 'h.B.Serve')).toEqual(['h.Wrap']);
    expect(store.callers('h.A.Serve')).toEqual([]);
    store.close();
  }, 30000);

  // Nothing is known about the source name, so nothing is known about the copy.
  it('claims nothing when the name it copied has no type', async () => {
    write('h/h.go', `package h
import "github.com/third/ext"
type Impl struct{}
func (i *Impl) Serve() error { return nil }
func Wrap() error {
	next := ext.New()
	copy := next
	return copy.Serve()
}
`);
    const store = await indexed();

    expect(certain(store, 'h.Impl.Serve')).toEqual([]);
    store.close();
  }, 30000);

  // `a, b := x, y` pairs by index, the way Go does.
  it('pairs a multi-name copy by position', async () => {
    write('h/h.go', `package h
type A struct{}
func (a *A) Serve() error { return nil }
type B struct{}
func (b *B) Run() error { return nil }
func Wrap(x *A, y *B) error {
	p, q := x, y
	if err := p.Serve(); err != nil {
		return err
	}
	return q.Run()
}
`);
    const store = await indexed();

    expect(certain(store, 'h.A.Serve')).toEqual(['h.Wrap']);
    expect(certain(store, 'h.B.Run')).toEqual(['h.Wrap']);
    store.close();
  }, 30000);
});
