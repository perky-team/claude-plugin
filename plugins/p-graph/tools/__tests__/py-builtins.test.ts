import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-pybuiltin-')); });
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

// Go has had GO_BUILTINS since the start and TypeScript got JS_GLOBALS; Python
// had neither. `set(xs)` is the builtin that makes a set — it is not a call of
// anyone's `.set()` method — but nothing said so. Measured on httpx: two of the
// seven rows under `callers "Cookies.set"` were `set(urls)` and `set(params)`,
// and that banner cost the run ten steps against grep's five.
describe('a call to a Python builtin', () => {
  // Two classes own the name, which is the shape httpx has: `Cookies.set` and
  // `QueryParams.set`. With two candidates the bare-name fallback refuses to
  // guess, so the call lands in the gap report instead — which is where it was
  // being listed as work for the reader.
  const twoOwners = `class Cookies:
    def set(self, name, value):
        self._jar[name] = value


class QueryParams:
    def set(self, key, value):
        return key


def unique(urls):
    return len(set(urls))
`;

  it('is not listed as a missing call site of a repo method of that name', async () => {
    write('app/models.py', twoOwners);
    const store = await indexed();

    // Still reported — a call the resolver refuses is never dropped — but under
    // the external reason, which the banner counts in one line instead of
    // listing as a row for the reader to go and grep for.
    const rows = store.gapsFor('Cookies.set');
    expect(rows.map((g) => `${g.file}:${g.line}`)).toEqual(['app/models.py:12']);
    expect(rows.map((g) => g.reason)).toEqual(['external']);
    store.close();
  }, 30000);

  it('is still counted, under the external reason — never dropped', async () => {
    write('app/models.py', twoOwners);
    const store = await indexed();

    const gaps = store.gapsFrom('unique');
    expect(gaps.map((g) => g.dst_name).sort()).toEqual(['len', 'set']);
    expect(gaps.every((g) => g.reason === 'external')).toBe(true);
    store.close();
  }, 30000);

  it('resolves to the repo function when the repo declares its own', async () => {
    // Python lets a module declare `def set(...)`. When exactly one repo
    // function carries the name, a plain call to it is that function — the same
    // rule Go's resolveShadowedBuiltins applies to `max`.
    write('app/store.py', `def set(key, value):
    return (key, value)


def save():
    return set("a", 1)
`);
    const store = await indexed();

    expect(store.callers('set').map((n) => n.qname)).toEqual(['save']);
    expect(store.callers('set').every((r) => r.guess === 0)).toBe(true);
    expect(store.gapsFor('set')).toEqual([]);
    store.close();
  }, 30000);

  it('leaves a method call written on a receiver alone', async () => {
    // `jar.set(...)` is a member call, not a plain name. The builtin list must
    // never touch it, or a real call site would vanish.
    write('app/models.py', `${twoOwners}

def save(jar):
    jar.set("a", 1)
`);
    const store = await indexed();

    // Line 12 is the builtin and line 16 is the real member call. Both are
    // reported; only the member call is listed for the reader.
    const rows = store.gapsFor('Cookies.set');
    expect(rows.map((g) => `${g.line}:${g.reason}`)).toEqual(['12:external', '16:ambiguous']);
    store.close();
  }, 30000);
});
