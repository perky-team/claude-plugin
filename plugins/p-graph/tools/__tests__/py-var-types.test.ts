import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-pyvar-')); });
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

// `jar = RequestsCookieJar()` and `close_server = threading.Event()` are the same
// shape to a parser: a name bound to the result of a call. One names a class this
// repo defines, the other does not — and psf/requests writes both, which is why
// `RequestsCookieJar.set` used to print 22 false rows next to its 16 real ones.
describe('a Python variable bound to a constructor call', () => {
  it('resolves a call on it to that class, and calls it certain', async () => {
    write('cookies.py', `class Jar:
    def set(self, k, v):
        pass

class Other:
    def set(self, k, v):
        pass
`);
    write('use.py', `from cookies import Jar

def store_one():
    jar = Jar()
    jar.set("a", "b")
`);
    const s = await indexed();

    expect(s.callers('Jar.set')).toMatchObject([{ qname: 'store_one', guess: 0 }]);
    // The bare name `set` is shared, so nothing may leak to the other class.
    expect(s.callers('Other.set')).toEqual([]);
    s.close();
  }, 30000);

  it('refuses a call on a variable built from a class outside the repo', async () => {
    write('sync.py', `class Latch:
    def set(self):
        pass
`);
    write('serve.py', `import threading

def run():
    close_server = threading.Event()
    close_server.set()
`);
    const s = await indexed();

    // threading.Event is not ours, so the one repo method named `set` must not
    // claim the call...
    expect(s.callers('Latch.set')).toEqual([]);
    // ...and the call site is named instead of dropped.
    expect(s.gapsFor('Latch.set').length).toBeGreaterThan(0);
    s.close();
  }, 30000);

  it('follows a module-qualified constructor of a repo class', async () => {
    write('pkg/__init__.py', '');
    write('pkg/cookies.py', `class Jar:
    def set(self, k, v):
        pass
`);
    write('use.py', `import pkg.cookies

def store_one():
    jar = pkg.cookies.Jar()
    jar.set("a", "b")
`);
    const s = await indexed();

    expect(s.callers('Jar.set')).toMatchObject([{ qname: 'store_one', guess: 0 }]);
    s.close();
  }, 30000);

  // The boundary, stated so it is not rediscovered as a bug: the receiver has to be
  // a plain name. `self.ready_event.set()` is a call on an attribute, and nothing
  // here records what an attribute holds.
  it('leaves a call on an attribute where it was', async () => {
    write('sync.py', `class Latch:
    def set(self):
        pass
`);
    write('serve.py', `import threading

class Server:
    def __init__(self):
        self.ready = threading.Event()

    def go(self):
        self.ready.set()
`);
    const s = await indexed();

    // Unchanged behaviour: the bare name is unique in the repo, so it still links
    // as a guess. It is marked, not presented as fact.
    const rows = s.callers('Latch.set');
    expect(rows.every((r) => r.guess === 1)).toBe(true);
    s.close();
  }, 30000);
});
