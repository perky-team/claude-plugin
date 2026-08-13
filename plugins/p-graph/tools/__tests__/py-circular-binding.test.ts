import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-pycirc-')); });
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

const OWNERS = `class Cookies:
    def set(self, name, value):
        return name


class QueryParams:
    def set(self, key, value):
        return QueryParams()
`;

// A Python variable key carries no position — Python has no block scope, so one
// name is one binding for the whole function. That is right, but it means two
// assignments to one name write two type rows for one key, and every pass reads
// two types as a conflict and refuses.
//
// `q = q.set(...)` is the shape that made this bite. The row it writes says "q
// is whatever q.set returns" — which can only be worked out from q's type, the
// very thing the row is meant to supply. It can never resolve anything and it
// can always conflict. Nine such keys in httpx, four in requests.
describe('a Python name bound from a call on itself', () => {
  it('does not lose the type the first binding stated', async () => {
    write('app/test_params.py', `${OWNERS}


def test_queryparam_set():
    q = QueryParams("a=123")
    q = q.set("a", "456")
    return q
`);
    const store = await indexed();

    expect(store.callers('QueryParams.set').map((n) => n.qname)).toEqual(['test_queryparam_set']);
    expect(store.callers('QueryParams.set').every((r) => r.guess === 0)).toBe(true);
    expect(store.callers('Cookies.set')).toEqual([]);
    store.close();
  }, 30000);

  it('still refuses when the two bindings really are two types', async () => {
    // Not circular: two different constructors for one name. Picking either
    // would need to know which line runs, which is flow analysis, not scope.
    write('app/pick.py', `${OWNERS}


def pick(flag):
    q = QueryParams()
    if flag:
        q = Cookies()
    q.set("a", "1")
`);
    const store = await indexed();

    expect(store.callers('QueryParams.set')).toEqual([]);
    expect(store.callers('Cookies.set')).toEqual([]);
    expect(store.gapsFor('QueryParams.set').map((g) => g.line)).toEqual([16]);
    store.close();
  }, 30000);
});
