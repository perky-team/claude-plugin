import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-pywith-')); });
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

const OWNERS = `class Response:
    def raise_for_status(self):
        return self


class Reply:
    def raise_for_status(self):
        return self
`;

// `with httpx.Client() as client:` is how httpx's own tests open a client, and
// every call on `client` after it hangs off that binding. Nothing recorded a
// type for it, so `response = client.request(...)` gave "whatever client.request
// returns" — a marker that leads nowhere — and the four call sites of
// `Response.raise_for_status` in those two files stayed missing.
describe('a Python name bound by a with statement', () => {
  it('takes the type of the value the with statement opens', async () => {
    write('app/api.py', `${OWNERS}


class Client:
    def __enter__(self):
        return self

    def request(self) -> Response:
        return Response()


def check():
    with Client() as client:
        r = client.request()
        r.raise_for_status()
`);
    const store = await indexed();

    expect(store.callers('Response.raise_for_status').map((n) => n.qname)).toEqual(['check']);
    expect(store.callers('Response.raise_for_status').every((r) => r.guess === 0)).toBe(true);
    store.close();
  }, 30000);

  it('does the same for async with', async () => {
    write('app/api.py', `${OWNERS}


class AsyncClient:
    async def __aenter__(self):
        return self

    async def request(self) -> Response:
        return Response()


async def check():
    async with AsyncClient() as client:
        r = await client.request()
        r.raise_for_status()
`);
    const store = await indexed();

    expect(store.callers('Response.raise_for_status').map((n) => n.qname)).toEqual(['check']);
    store.close();
  }, 30000);
});

// The C++ round gave a gap row whose receiver the source types as a library
// type its own reason, so the banner counts it in one line instead of sending
// the reader to grep for it. Python had no equivalent, and on httpx three of
// the seven rows under `callers "Cookies.set"` were exactly that.
describe('a Python receiver the source types outside the repo', () => {
  const OWNERS_SET = `class Cookies:
    def set(self, name, value):
        return name


class QueryParams:
    def set(self, key, value):
        return key
`;

  it('is counted under the library reason, not listed', async () => {
    write('app/server.py', `import asyncio

${OWNERS_SET}


class Server:
    def __init__(self):
        self.restart_requested = asyncio.Event()

    def restart(self):
        self.restart_requested.set()
`);
    const store = await indexed();

    const gaps = store.gapsFor('Cookies.set');
    expect(gaps.map((g) => `${g.line}:${g.reason}`)).toEqual(['19:library']);
    store.close();
  }, 30000);

  it('follows one hop through a repo function whose return type is a library type', async () => {
    // httpx writes `response_complete = create_event()`, and
    // `def create_event() -> Event` where Event is an alias for asyncio's.
    // The type is two facts away, both of them written in the source.
    write('app/asgi.py', `import asyncio

${OWNERS_SET}


def create_event() -> asyncio.Event:
    return asyncio.Event()


def run():
    done = create_event()
    done.set()
`);
    const store = await indexed();

    const gaps = store.gapsFor('Cookies.set');
    expect(gaps.map((g) => `${g.line}:${g.reason}`)).toEqual(['20:library']);
    store.close();
  }, 30000);

  it('drops a row whose receiver is a different repo class, even one that inherits the method', async () => {
    // requests writes `cid = CaseInsensitiveDict()` then `cid.update(...)`.
    // CaseInsensitiveDict is a repo class but does not declare `update` — it
    // inherits it — so nothing resolves, and the row was landing in the gap
    // list of `RequestsCookieJar.update`, which it can never be a call of.
    write('app/dicts.py', `class Jar:
    def update(self, other):
        return other


class Bag(dict):
    pass


def use():
    b = Bag()
    b.update({})
`);
    const store = await indexed();

    expect(store.gapsFor('Jar.update')).toEqual([]);
    store.close();
  }, 30000);

  it('does not label a receiver whose type the source never states', async () => {
    // Nothing is written down here, so nothing is proved. The row stays a
    // listed gap — the reader really does have to look.
    write('app/plain.py', `${OWNERS_SET}


def run(thing):
    thing.set("a", 1)
`);
    const store = await indexed();

    expect(store.gapsFor('Cookies.set').map((g) => g.reason)).toEqual(['ambiguous']);
    store.close();
  }, 30000);
});
