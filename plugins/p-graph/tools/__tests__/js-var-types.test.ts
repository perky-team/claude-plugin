import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-jsvar-')); });
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

// Two owners of `has`, so nothing here can be answered by the bare-name fallback.
const OWNERS = `export class AxiosHeaders {
  has(name) {
    return name in this;
  }
}

export class Params {
  has(key) {
    return key in this;
  }
}
`;

// ts.scm has recorded what a name is bound to since the TypeScript round;
// js.scm never got the same rules, so in a plain .js file p-graph recorded no
// variable binding and no type at all. Every identifier receiver fell through
// to the "#static:" key, found no class of that name, and became a bare-name
// guess. Measured on axios — 191 .js files against 23 .ts — that left 9 of
// 7,940 member calls resolved with certainty, 0.1%, the lowest in the study.
describe('a value bound in a plain .js file', () => {
  it('types the receiver, so the call on it is certain', async () => {
    // This is how axios' own tests write it, one line above the call.
    write('lib/headers.js', OWNERS);
    write('test/headers.test.js', `import { AxiosHeaders } from '../lib/headers.js';

function itKeepsCase() {
  const headers = new AxiosHeaders();
  return headers.has('foo');
}
`);
    const store = await indexed();

    expect(store.callers('AxiosHeaders.has').map((n) => n.qname)).toEqual(['itKeepsCase']);
    expect(store.callers('AxiosHeaders.has').every((r) => r.guess === 0)).toBe(true);
    expect(store.callers('Params.has')).toEqual([]);
    store.close();
  }, 30000);

  it('refuses the guess when the value is a JavaScript builtin', async () => {
    // `const visited = new WeakSet()` in axios' lib/utils.js. One repo class
    // owns `has`, so the bare-name fallback used to answer this — wrongly.
    write('lib/headers.js', `export class AxiosHeaders {
  has(name) {
    return name in this;
  }
}
`);
    write('lib/utils.js', `export const toJSONObject = (obj) => {
  const visited = new WeakSet();
  return visited.has(obj);
};
`);
    const store = await indexed();

    expect(store.callers('AxiosHeaders.has')).toEqual([]);
    const gaps = store.gapsFor('AxiosHeaders.has');
    expect(gaps.map((g) => `${g.line}:${g.reason}`)).toEqual(['3:library']);
    store.close();
  }, 30000);

  it('still resolves a call on a parameter it cannot type', async () => {
    // Nothing states what `set` is, so the one repo owner is still the honest
    // guess. The new rules must not turn a working answer into a refusal.
    write('lib/headers.js', `export class AxiosHeaders {
  has(name) {
    return name in this;
  }
}

export function strip(set, header) {
  return set.has(header);
}
`);
    const store = await indexed();

    const rows = store.callers('AxiosHeaders.has');
    expect(rows.map((n) => n.qname)).toEqual(['strip']);
    expect(rows.every((r) => r.guess === 1)).toBe(true);
    store.close();
  }, 30000);

  it('does not break the definitions a .js file already had', async () => {
    write('lib/thing.js', `export class Thing {
  run(a, b = 1, ...rest) {
    return this.go(a);
  }

  go(a) {
    return a;
  }
}
`);
    const store = await indexed();

    expect(store.callers('Thing.go').map((n) => n.qname)).toEqual(['Thing.run']);
    store.close();
  }, 30000);
});
