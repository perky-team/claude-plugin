import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-member-')); });
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

describe('a member call needs a target with an owner', () => {
  it('does not link every .end() to a local arrow function named end', async () => {
    write('http2.ts', `export class Req {
  _final(cb: () => void): void {
    const end = () => { this.stream.end(cb); };
    end();
  }
}
export function serve(response: any) { response.end('bye'); }
`);
    const store = await indexed();

    // `end` is a local arrow function with no owner. Only the plain `end()` call
    // on the line below it can target it — not `response.end(...)`.
    expect(store.callers('end').length).toBeLessThanOrEqual(1);
    const rows = store.callers('end').map((n) => n.qname);
    expect(rows).not.toContain('serve');

    store.close();
  }, 30000);

  it('still links a member call to a real method', async () => {
    write('repo.ts', `export class UserRepo { get(id: string) { return id; } }
export function read(r: UserRepo) { return r.get('1'); }
`);
    const store = await indexed();

    expect(store.callers('UserRepo.get').map((n) => n.qname)).toEqual(['read']);

    store.close();
  }, 30000);

  it('still links a TypeScript constructor call', async () => {
    write('app.ts', `export class Service { run() {} }
export function boot() { return new Service(); }
`);
    const store = await indexed();

    expect(store.callers('Service').map((n) => n.qname)).toEqual(['boot']);

    store.close();
  }, 30000);

  it('resolves a call to a member of a TypeScript namespace', async () => {
    write('util.ts', `export namespace Util {
  export function slug(s: string) { return s; }
}
export function use() { return Util.slug('X'); }
`);
    const store = await indexed();

    // A namespace owns its members, so `Util.slug(...)` is a member call with a
    // real owner. Without the namespace indexed, `slug` has no owner at all and
    // the member rule refuses the call.
    expect(store.callers('Util.slug').map((n) => n.qname)).toEqual(['use']);

    store.close();
  }, 30000);

  it('resolves a call to a method of a class expression', async () => {
    write('widget.ts', `export const Widget = class { render() { return 1; } };
export function draw(w: any) { return w.render(); }
`);
    const store = await indexed();

    // The class has no declaration of its own — the variable names it. Index it
    // anyway, or every method it holds loses its owner and no member call can
    // reach it.
    expect(store.callers('Widget.render').map((n) => n.qname)).toEqual(['draw']);

    store.close();
  }, 30000);

  it('resolves a Python call through an imported module but not through a value', async () => {
    write('api.py', `def get(url):
    return url
`);
    write('client.py', `import api

class Session:
    def get(self, url):
        return url

def fetch(s):
    api.get('http://x')
    s.get('http://y')
`);
    const store = await indexed();

    // api.get is module-qualified, so it resolves. s.get is a call on a value
    // whose type is unknown, so it must not resolve to the module function.
    expect(store.callers('get').map((n) => n.qname)).toEqual(['fetch']);
    expect(store.gapsFor('Session.get').length).toBeGreaterThan(0);

    store.close();
  }, 30000);

  it('resolves a Python call through an import alias', async () => {
    write('api.py', `def fetch_one(url):
    return url
`);
    write('client.py', `import api as backend

def run():
    backend.fetch_one('http://x')
`);
    const store = await indexed();

    // `import api as backend` binds the module to `backend`, so this call is
    // module-qualified even though the object is not the module's own name.
    expect(store.callers('fetch_one').map((n) => n.qname)).toEqual(['run']);

    store.close();
  }, 30000);

  it('refuses a Python call on a name imported with "from x import y"', async () => {
    write('api.py', `def load(url):
    return url
`);
    write('client.py', `from helpers import api

def run():
    api.load('http://x')
`);
    const store = await indexed();

    // `from helpers import api` may bind a module or a value — the source does
    // not say. We refuse rather than guess, so this stays a reported gap.
    expect(store.callers('load')).toEqual([]);
    expect(store.gapsFor('load').length).toBeGreaterThan(0);

    store.close();
  }, 30000);

  it('keeps a Go package-qualified call working', async () => {
    write('a/a.go', `package a
func Do() {}
`);
    write('b/b.go', `package b
import "x/a"
func Use() { a.Do() }
`);
    const store = await indexed();

    // Go writes a package call as a member access too, but a Go qname already
    // carries the package, so the owner rule must not touch it.
    expect(store.callers('a.Do').map((n) => n.qname)).toEqual(['b.Use']);

    store.close();
  }, 30000);

  it('refuses to let this.m() reach a module-level function of the same name', async () => {
    write('app.ts', `export function helper() { return 1; }
export class App { run() { return this.helper(); } }
`);
    const store = await indexed();

    // App has no method `helper`, so the own-receiver fallback used to land on
    // the module-level function. `this.helper()` can never mean that.
    expect(store.callers('helper')).toEqual([]);

    store.close();
  }, 30000);

  it('never turns an ambiguous bare name into a resolved one', async () => {
    write('ctx.py', `class Globals:
    def setdefault(self, k, v):
        return v

def helper(mapping):
    def setdefault(k):
        return k
    return setdefault
`);
    write('app.py', `def run(options):
    options.setdefault("debug", True)
`);
    const store = await indexed();

    // Two symbols are named setdefault, so the bare name was never a safe guess.
    // The owner rule may refuse a link. It must never make one — dropping the
    // local `setdefault` from the candidates would leave a single "unique" match
    // and link every dict.setdefault() call in the repo to the class method.
    expect(store.callers('Globals.setdefault')).toEqual([]);

    store.close();
  }, 30000);

  it('records the member flag for every language', async () => {
    write('m.ts', `export function a(x: any) { x.run(); b(); }
export function b() {}
`);
    write('m.py', `def a(x):
    x.run()
    b()

def b():
    pass
`);
    write('m.cpp', `void b() {}
void a(int x) { x.run(); b(); }
`);
    write('g/g.go', `package g
import "fmt"
func b() {}
func a() { fmt.Println("x"); b() }
`);
    const store = await indexed();

    const rows = store.db.prepare(
      `SELECT lang, dst_bare, member FROM edges WHERE kind = 'call' ORDER BY lang, dst_bare`).all();
    const flag = (lang, bare) => rows.find((r) => r.lang === lang && r.dst_bare === bare)?.member;
    for (const lang of ['ts', 'py', 'cpp']) {
      expect(flag(lang, 'run'), `${lang} member call`).toBe(1);
      expect(flag(lang, 'b'), `${lang} plain call`).toBe(0);
    }
    expect(flag('go', 'Println'), 'go member call').toBe(1);
    expect(flag('go', 'b'), 'go plain call').toBe(0);

    store.close();
  }, 30000);
});
