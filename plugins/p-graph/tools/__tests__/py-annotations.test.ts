import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-pyann-')); });
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

// Two classes own the method name throughout this file. That is deliberate:
// with one owner the bare-name fallback answers anyway and the test would pass
// without reading a single annotation.
const TWO_OWNERS = `class Response:
    def raise_for_status(self):
        return self


class Reply:
    def raise_for_status(self):
        return self
`;

// Python was the only supported language whose type annotations p-graph did not
// read at all. The whole of `field_types` for a Python repo was `x = Call()`.
// Measured on three repositories: member calls resolved with certainty were
// 5.8% on flask, 17.4% on requests and 20.8% on httpx, against 59% for leveldb
// after C++ learned to read the type on a receiver.
describe('a Python type annotation', () => {
  it('types a parameter, so the call on it is certain', async () => {
    write('app/api.py', `${TWO_OWNERS}

def check(r: Response):
    r.raise_for_status()
`);
    const store = await indexed();

    expect(store.callers('Response.raise_for_status').map((n) => n.qname)).toEqual(['check']);
    expect(store.callers('Response.raise_for_status').every((r) => r.guess === 0)).toBe(true);
    expect(store.callers('Reply.raise_for_status')).toEqual([]);
    store.close();
  }, 30000);

  it('types a parameter that also has a default', async () => {
    write('app/api.py', `${TWO_OWNERS}

def check(r: Response = None):
    r.raise_for_status()
`);
    const store = await indexed();

    expect(store.callers('Response.raise_for_status').map((n) => n.qname)).toEqual(['check']);
    store.close();
  }, 30000);

  it('types a variable declared with an annotation', async () => {
    write('app/api.py', `${TWO_OWNERS}

def check(client):
    r: Response = client.send()
    r.raise_for_status()
`);
    const store = await indexed();

    expect(store.callers('Response.raise_for_status').map((n) => n.qname)).toEqual(['check']);
    store.close();
  }, 30000);

  it('reads the return type, so a value the call produced is typed', async () => {
    write('app/api.py', `${TWO_OWNERS}

def fetch() -> Response:
    return Response()


def check():
    r = fetch()
    r.raise_for_status()
`);
    const store = await indexed();

    expect(store.callers('Response.raise_for_status').map((n) => n.qname)).toEqual(['check']);
    expect(store.callers('Response.raise_for_status').every((r) => r.guess === 0)).toBe(true);
    store.close();
  }, 30000);

  it('reads through await, which was skipped entirely', async () => {
    // `x = await f()` puts an `await` node on the right of the assignment, not
    // a `call`, so extraction recorded no type for x at all. httpx has 70 such
    // bindings, and two of them are the missing rows under
    // `callers "Response.raise_for_status"`.
    write('app/api.py', `${TWO_OWNERS}

async def fetch() -> Response:
    return Response()


async def check():
    r = await fetch()
    r.raise_for_status()
`);
    const store = await indexed();

    expect(store.callers('Response.raise_for_status').map((n) => n.qname)).toEqual(['check']);
    store.close();
  }, 30000);

  it('refuses to guess when the annotation names a type outside the repo', async () => {
    // One repo class owns `set`, so today the bare-name fallback answers this
    // call with it. The source says the receiver is a threading.Event, so that
    // answer is wrong — and a recorded type that leads nowhere is exactly the
    // signal Pass B already honours for Go and TypeScript.
    write('app/jar.py', `import threading


class Cookies:
    def set(self, name, value):
        self._jar[name] = value


def wake(e: threading.Event):
    e.set()
`);
    const store = await indexed();

    expect(store.callers('Cookies.set')).toEqual([]);
    const gaps = store.gapsFor('Cookies.set');
    expect(gaps.map((g) => g.line)).toEqual([10]);
    store.close();
  }, 30000);

  it('ignores an annotation it cannot read plainly, rather than guessing at it', async () => {
    // `Optional[Response]` is a subscript. Taking the inner type is a further
    // step; recording the wrong thing here would be worse than recording
    // nothing, so nothing is recorded and the old behaviour stands.
    write('app/api.py', `import typing

${TWO_OWNERS}

def check(r: typing.Optional[Response]):
    r.raise_for_status()
`);
    const store = await indexed();

    expect(store.callers('Response.raise_for_status')).toEqual([]);
    expect(store.gapsFor('Response.raise_for_status').map((g) => g.line)).toEqual([14]);
    store.close();
  }, 30000);

  it('follows a forward reference written as a string', async () => {
    write('app/api.py', `${TWO_OWNERS}

def check(r: "Response"):
    r.raise_for_status()
`);
    const store = await indexed();

    expect(store.callers('Response.raise_for_status').map((n) => n.qname)).toEqual(['check']);
    store.close();
  }, 30000);
});
