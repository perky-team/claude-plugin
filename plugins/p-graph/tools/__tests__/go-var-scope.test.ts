import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';
import { resolveLang } from '../lib/parse/index.mjs';
import { extract } from '../lib/parse/driver.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-scope-')); });
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
// The one call edge on a given line, with the target it ended up at.
const callAt = (store, file, line) => store.db.prepare(`
  SELECT e.dst_name, e.field_key, e.method, d.qname AS dst_qname
  FROM edges e LEFT JOIN nodes d ON d.id = e.dst_id
  WHERE e.kind = 'call' AND e.file = ? AND e.line = ?`).get(file, line) ?? null;

// A name bound inside a Go function is visible from the end of its own
// declaration to the end of the block that holds it. Reading it as visible
// everywhere in the function loses true edges — and, when the shadow has a
// readable type, silently asserts a false one.
describe('Go variable scope', () => {
  it('reads the right-hand side of `watcher, err := watcher.New(...)` as the package', async () => {
    write('watcher/watcher.go', `package watcher
type Watcher struct{}
func New(interval int) (*Watcher, error) { return nil, nil }
`);
    // A second New keeps the bare name from being repo-unique, so a lost
    // qualifier shows up as a missing edge instead of being papered over by the
    // bare-name fallback.
    write('poll/poll.go', `package poll
func New() {}
`);
    write('cmd/build.go', `package cmd
import "x/watcher"
func Build() error {
	watcher, err := watcher.New(500)
	_ = watcher
	return err
}
`);
    const store = await indexed();

    // Go starts the variable's scope at the END of its declaration, so the
    // `watcher` on the right is still the imported package. This is ordinary Go,
    // the same shape as `url, err := url.Parse(...)`.
    expect(store.callers('watcher.New').map((n) => n.qname)).toEqual(['cmd.Build']);

    store.close();
  }, 30000);

  it('does not let a declaration below the call site turn a package into a variable', async () => {
    write('config/config.go', `package config
type Cfg struct{}
func New() *Cfg { return nil }
`);
    write('decoy/decoy.go', `package decoy
func New() {}
`);
    write('services/services.go', `package services
import "x/config"
type Result struct{}
func Decode(c *config.Cfg) (*Result, error) { return nil, nil }
func Check() error {
	cfg := config.New()
	// The declaration of "config" is four lines below this call, exactly as in
	// the hugo file this comes from.
	//
	config, err := Decode(cfg)
	_ = config
	return err
}
`);
    const store = await indexed();

    expect(store.callers('config.New').map((n) => n.qname)).toEqual(['services.Check']);

    store.close();
  }, 30000);

  it('keeps a name bound in one closure out of a sibling closure', async () => {
    write('markup/markup.go', `package markup
func ResolveMarkup(s string) string { return s }
`);
    write('hugolib/content.go', `package hugolib
import "x/markup"
type Local struct{}
func (l *Local) ResolveMarkup(s string) string { return s }
func Outer() (string, string) {
	first := func() string {
		return markup.ResolveMarkup("md")
	}
	second := func() string {
		markup := &Local{}
		return markup.ResolveMarkup("md")
	}
	return first(), second()
}
`);
    const store = await indexed();

    // Line 7 sits in a closure that binds no "markup"; the binding on line 10
    // lives in a different closure and cannot reach it.
    expect(callAt(store, 'hugolib/content.go', 7).dst_qname).toBe('markup.ResolveMarkup');
    expect(callAt(store, 'hugolib/content.go', 11).dst_qname).toBe('hugolib.Local.ResolveMarkup');

    store.close();
  }, 30000);

  it('does not let a shadow inside a block claim the package call outside it', async () => {
    write('config/config.go', `package config
func Load() {}
`);
    write('api/api.go', `package api
import "x/config"
type Local struct{}
func (l *Local) Load() {}
func Do(flag bool) {
	if flag {
		config := &Local{}
		config.Load()
	}
	config.Load()
}
`);
    const store = await indexed();

    // The call inside the block belongs to the local; the one outside it is a
    // genuine call into the imported package. Answering both with the local is
    // the one thing this plugin promises cannot happen: a true edge gone AND a
    // false one asserted, with no gap row to show for it.
    expect(callAt(store, 'api/api.go', 8).dst_qname).toBe('api.Local.Load');
    const genuine = callAt(store, 'api/api.go', 10);
    expect(genuine.dst_qname).not.toBe('api.Local.Load');
    expect(genuine.dst_qname).toBe('config.Load');
    expect(store.callers('config.Load').map((n) => n.qname)).toEqual(['api.Do']);

    store.close();
  }, 30000);

  it('does not carry a shadowed variable type into a field call outside the shadow', async () => {
    write('core/core.go', `package core
type Core struct{}
func (c *Core) Action() {}
type Other struct{}
func (o *Other) Action() {}
`);
    write('api/api.go', `package api
import "x/core"
type Server struct{ dep *core.Core }
type Client struct{ dep *core.Other }
func makeClient() *Client { return nil }
func Run(flag bool) {
	if flag {
		s := &Server{}
		s.dep.Action()
	}
	s := makeClient()
	s.dep.Action()
}
`);
    const store = await indexed();

    // Line 9 really is a *Server. Line 12 is a *Client, and its dep type is only
    // knowable through makeClient's return type, which extraction does not read —
    // so that call must be refused and reported, not given the *Server field.
    expect(callAt(store, 'api/api.go', 9).dst_qname).toBe('core.Core.Action');
    const outer = callAt(store, 'api/api.go', 12);
    expect(outer.field_key).toBeNull();
    expect(outer.dst_qname).toBeNull();
    expect(store.gapsFor('core.Other.Action').length).toBeGreaterThan(0);

    store.close();
  }, 30000);
});

// A package-level variable is shared by every file of its package. A package is
// one directory, so the key has to name the directory: two directories can both
// declare `package tpl`, and a qname or a package name alone cannot tell them
// apart.
describe('Go package-level variable keys', () => {
  it('keeps two packages of the same name in different directories apart', async () => {
    write('pool/pool.go', `package pool
type Keeper struct{}
func (k *Keeper) Get() string { return "" }
`);
    write('other/other.go', `package other
type Bag struct{}
func (b *Bag) Get() string { return "" }
func NewBag() *Bag { return nil }
`);
    write('a/tpl/one.go', `package tpl
import "x/pool"
var shared = &pool.Keeper{}
func UseA() string { return shared.Get() }
`);
    write('b/tpl/two.go', `package tpl
import "x/other"
var shared = other.NewBag()
func UseB() string { return shared.Get() }
`);
    const store = await indexed();

    // UseB never touches pool.Keeper. Its own `shared` takes its type from a
    // function's return value, which extraction does not read, so that call has
    // to be reported rather than answered with the other directory's type.
    expect(store.callers('pool.Keeper.Get').map((n) => n.qname)).toEqual(['tpl.UseA']);
    expect(store.gapsFor('other.Bag.Get').length).toBeGreaterThan(0);

    store.close();
  }, 30000);

  it('keeps two same-named functions in one package apart', async () => {
    write('store/store.go', `package store
type Postgres struct{}
func (p *Postgres) Get() string { return "" }
type Memory struct{}
func (m *Memory) Get() string { return "" }
func NewMemory() *Memory { return nil }
`);
    write('api/one.go', `package api
import "x/store"
func init() {
	db := &store.Postgres{}
	db.Get()
}
`);
    write('api/two.go', `package api
import "x/store"
func init() {
	db := store.NewMemory()
	db.Get()
}
`);
    const store = await indexed();

    // Go allows many func init() per package, so a qname is not unique. Only one
    // of the two `db`s has a type we can read, and it must not answer for the
    // other file's call.
    expect(store.callers('store.Postgres.Get')).toHaveLength(1);
    expect(store.gapsFor('store.Memory.Get').length).toBeGreaterThan(0);

    store.close();
  }, 30000);
});

describe('Go const declarations', () => {
  it('types a const of a named type instead of leaving the call to the bare name', async () => {
    write('color/color.go', `package color
type Shade int
func (s Shade) Name() string { return "" }
type Other int
func (o Other) Name() string { return "" }
`);
    write('ui/ui.go', `package ui
import "x/color"
const dark color.Shade = 1
func Label() string { return dark.Name() }
`);
    const store = await indexed();

    // A const binds a name and can state a type, exactly like a var. Left out, the
    // name fell through to the package-variable path, where a package-level var of
    // the same name could have answered for it.
    expect(store.callers('color.Shade.Name').map((n) => n.qname)).toEqual(['ui.Label']);
    expect(store.callers('color.Other.Name')).toEqual([]);

    store.close();
  }, 30000);
});

// `a, b *T` and `var a, b *T` bind two names to one type. The grammar gives the
// comma token of a var_spec the `name` field too, so reading names with a query
// pattern silently drops every second one.
describe('Go declarations that bind two names to one type', () => {
  it('records a row for each name a Go declaration binds', async () => {
    const src = `package api
import "x/store"
func Pair(a, b *store.Postgres) {}
func Vars() {
	var c, d *store.Postgres
	_, _ = c, d
}
`;
    const cfg = resolveLang('api/api.go');
    const { fieldTypes } = await extract(
      { file: 'api/api.go', lang: cfg.lang, langId: cfg.langId, scm: cfg.query, source: src });

    for (const name of ['a', 'b', 'c', 'd']) {
      const rows = fieldTypes.filter((f) => new RegExp(`#var:${name}(@|$)`).test(f.key));
      expect(rows.map((r) => r.type)).toEqual(['store.Postgres']);
    }
    // The comma token must never become a row of its own.
    expect(fieldTypes.some((f) => /#var:,/.test(f.key))).toBe(false);
  }, 20000);

  it('resolves a call on every name of a two-name declaration', async () => {
    write('store/store.go', `package store
type Postgres struct{}
func (p *Postgres) Get() string { return "" }
type Memory struct{}
func (m *Memory) Get() string { return "" }
`);
    write('api/api.go', `package api
import "x/store"
func Pair(a, b *store.Postgres) string { return a.Get() + b.Get() }
func Vars() string {
	var c, d *store.Postgres
	return c.Get() + d.Get()
}
`);
    const store = await indexed();

    // store.Memory.Get shares the bare name, so a resolved call can only come
    // from the declared type — not from the bare-name fallback.
    expect(store.callers('store.Postgres.Get').map((n) => n.qname).sort())
      .toEqual(['api.Pair', 'api.Vars']);
    expect(store.callers('store.Memory.Get')).toEqual([]);
    // All four call sites, so neither second name was dropped.
    const resolved = store.db.prepare(`
      SELECT count(*) AS c FROM edges e JOIN nodes d ON d.id = e.dst_id
      WHERE e.file = 'api/api.go' AND d.qname = 'store.Postgres.Get'`).get().c;
    expect(resolved).toBe(4);

    store.close();
  }, 30000);
});
