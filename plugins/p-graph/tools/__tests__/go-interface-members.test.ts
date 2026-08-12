import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-goiface-')); });
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

// An interface is how Go names a set of methods, and a call through one is the
// language's defining idiom. The graph had the interface node but none of its
// members, so a call on a value of that type could never land anywhere:
// `pgraph callers "caddyhttp.Handler.ServeHTTP"` answered "no symbol named …".
// Measured: 328 interfaces in hugo and 66 in caddy, 0 members between them, and
// 1,241 hugo call edges and 91 caddy ones pointing at a repo interface.
describe('a method declared on a Go interface', () => {
  it('is a node owned by the interface', async () => {
    write('config/config.go', `package config

type Provider interface {
	Set(key string, value any)
}
`);
    const store = await indexed();

    expect(store.db.prepare(
      `SELECT kind, qname FROM nodes WHERE lang='go' AND name='Set'`).all())
      .toEqual([{ kind: 'method', qname: 'config.Provider.Set' }]);
    store.close();
  }, 30000);

  it('answers a call made through the interface', async () => {
    write('config/config.go', `package config

type Provider interface {
	Set(key string, value any)
}
`);
    write('app/app.go', `package app

import "x/config"

func Run(p config.Provider) {
	p.Set("k", 1)
}
`);
    const store = await indexed();

    expect(certain(store, 'config.Provider.Set')).toEqual(['app.Run']);
    store.close();
  }, 30000);

  // The concrete type keeps its own node and its own callers. A call written on
  // the struct is a call on the struct, not on the interface.
  it('does not take the concrete type\'s callers', async () => {
    write('config/config.go', `package config

type Provider interface {
	Set(key string, value any)
}

type Map struct{}

func (m *Map) Set(key string, value any) {}

func Direct(m *Map) {
	m.Set("k", 1)
}

func Through(p Provider) {
	p.Set("k", 1)
}
`);
    const store = await indexed();

    expect(certain(store, 'config.Map.Set')).toEqual(['config.Direct']);
    expect(certain(store, 'config.Provider.Set')).toEqual(['config.Through']);
    store.close();
  }, 30000);

  // A declaration is not a call: `Set(key string, value any)` inside the interface
  // body must not look like a call to itself.
  it('does not call itself', async () => {
    write('config/config.go', `package config

type Provider interface {
	Set(key string, value any)
	Get(key string) any
}
`);
    const store = await indexed();

    expect(store.callers('config.Provider.Set')).toEqual([]);
    expect(store.callers('config.Provider.Get')).toEqual([]);
    store.close();
  }, 30000);

  // An embedded interface is a type name, not a method. It must not become a node
  // called `Reader`, and it must not stop the real methods being indexed.
  it('ignores an embedded interface in the body', async () => {
    write('config/config.go', `package config

type Reader interface {
	Get(key string) any
}

type Provider interface {
	Reader
	Set(key string, value any)
}
`);
    const store = await indexed();

    expect(store.db.prepare(
      `SELECT qname FROM nodes WHERE lang='go' AND kind='method' ORDER BY qname`).all())
      .toEqual([{ qname: 'config.Provider.Set' }, { qname: 'config.Reader.Get' }]);
    store.close();
  }, 30000);

  // The graph must still refuse when the receiver's type is not written down.
  it('claims nothing when the receiver has no type', async () => {
    write('config/config.go', `package config

type Provider interface {
	Set(key string, value any)
}

func Run(p any) {
	p.(interface{ Set(string, any) }).Set("k", 1)
}
`);
    const store = await indexed();

    expect(certain(store, 'config.Provider.Set')).toEqual([]);
    store.close();
  }, 30000);
});
