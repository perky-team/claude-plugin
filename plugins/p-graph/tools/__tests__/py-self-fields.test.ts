import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-pyfield-')); });
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

// Two owners of the method name, so nothing here can be answered by the
// bare-name fallback. `set` is the real case: httpx has `Cookies.set` and
// `QueryParams.set`.
const OWNERS = `class Cookies:
    def set(self, name, value):
        return name


class QueryParams:
    def set(self, key, value):
        return key
`;

// `self.<field>.<method>()` is the shape Python writes most, and it was the one
// shape p-graph keyed for TypeScript and C++ and not for Python: the call
// carried no key at all, so no type could ever answer it. Counted on the three
// repositories: 115 such calls in httpx, 51 in flask, 36 in requests.
describe('a Python call written on self.<field>', () => {
  it('resolves through a field built in __init__', async () => {
    write('app/client.py', `${OWNERS}


class Client:
    def __init__(self):
        self.jar = Cookies()

    def save(self, k, v):
        self.jar.set(k, v)
`);
    const store = await indexed();

    expect(store.callers('Cookies.set').map((n) => n.qname)).toEqual(['Client.save']);
    expect(store.callers('Cookies.set').every((r) => r.guess === 0)).toBe(true);
    expect(store.callers('QueryParams.set')).toEqual([]);
    store.close();
  }, 30000);

  it('resolves through a field annotated on the class', async () => {
    write('app/client.py', `${OWNERS}


class Client:
    jar: Cookies

    def save(self, k, v):
        self.jar.set(k, v)
`);
    const store = await indexed();

    expect(store.callers('Cookies.set').map((n) => n.qname)).toEqual(['Client.save']);
    store.close();
  }, 30000);

  it('resolves through a field annotated where it is assigned', async () => {
    write('app/client.py', `${OWNERS}


class Client:
    def __init__(self, jar):
        self.jar: Cookies = jar

    def save(self, k, v):
        self.jar.set(k, v)
`);
    const store = await indexed();

    expect(store.callers('Cookies.set').map((n) => n.qname)).toEqual(['Client.save']);
    store.close();
  }, 30000);

  it('resolves through a property, by its return type', async () => {
    // httpx writes `return self.copy_with(params=self.params.set(key, value))`,
    // where `params` is a `@property` returning QueryParams. Reading the return
    // type is what tells `QueryParams.set` from `Cookies.set`.
    write('app/url.py', `${OWNERS}


class URL:
    @property
    def params(self) -> QueryParams:
        return self._params

    def copy_set_param(self, key, value):
        return self.params.set(key, value)
`);
    const store = await indexed();

    expect(store.callers('QueryParams.set').map((n) => n.qname)).toEqual(['URL.copy_set_param']);
    expect(store.callers('Cookies.set')).toEqual([]);
    store.close();
  }, 30000);

  it('refuses to guess when the field holds a library type', async () => {
    // `self.restart_requested = asyncio.Event()` in httpx's test server. With
    // one repo owner of `set` the bare-name fallback used to answer this, and
    // the answer was wrong.
    write('app/server.py', `import asyncio


class Cookies:
    def set(self, name, value):
        return name


class Server:
    def __init__(self):
        self.restart_requested = asyncio.Event()

    def restart(self):
        self.restart_requested.set()
`);
    const store = await indexed();

    expect(store.callers('Cookies.set')).toEqual([]);
    expect(store.gapsFor('Cookies.set').map((g) => g.line)).toEqual([14]);
    store.close();
  }, 30000);

  it('keeps two classes of one name in different files apart', async () => {
    // The key carries the file for the same reason C++ and TypeScript need it:
    // two repos-worth of `Client` in one repo would otherwise share one key.
    write('a/client.py', `${OWNERS}


class Client:
    def __init__(self):
        self.jar = Cookies()

    def save(self, k, v):
        self.jar.set(k, v)
`);
    write('b/client.py', `class Client:
    def __init__(self):
        self.jar = None

    def drop(self):
        self.jar.clear()
`);
    const store = await indexed();

    expect(store.callers('Cookies.set').map((n) => n.qname)).toEqual(['Client.save']);
    store.close();
  }, 30000);
});
