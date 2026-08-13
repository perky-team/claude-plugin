import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsfallback-')); });
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

const OWNERS = `export class Request {
  _beforeError(error: Error) {
    return error;
  }
}

export class Other {
  _beforeError(error: Error) {
    return error;
  }
}
`;

// `const c = new Conn()` has typed a name since the TypeScript round. The shape
// got actually writes is one step away and was not read:
// `const request = firstRequest ?? new Request(undefined, undefined, options)`.
// The right-hand side is a binary expression, not a new_expression, so nothing
// was recorded — and five call sites of `Request._beforeError` sat in the
// UNVERIFIED block because of it.
describe('a value that falls back to a constructor', () => {
  it('takes the constructed type through ??', async () => {
    write('src/a.ts', `${OWNERS}

export function makeRequest(firstRequest?: Request) {
  const request = firstRequest ?? new Request();
  request._beforeError(new Error('x'));
}
`);
    const store = await indexed();

    expect(store.callers('Request._beforeError').map((n) => n.qname)).toEqual(['makeRequest']);
    expect(store.callers('Request._beforeError').every((r) => r.guess === 0)).toBe(true);
    expect(store.callers('Other._beforeError')).toEqual([]);
    store.close();
  }, 30000);

  it('takes it through || as well', async () => {
    write('src/a.ts', `${OWNERS}

export function makeRequest(firstRequest?: Request) {
  const request = firstRequest || new Request();
  request._beforeError(new Error('x'));
}
`);
    const store = await indexed();

    expect(store.callers('Request._beforeError').map((n) => n.qname)).toEqual(['makeRequest']);
    store.close();
  }, 30000);

  it('refuses when the two sides construct different classes', async () => {
    // `new Request() ?? new Other()` names two types. Picking one would be a
    // guess dressed as knowledge.
    write('src/a.ts', `${OWNERS}

export function makeRequest(flag: boolean) {
  const request = (flag ? null : new Other()) ?? new Request();
  request._beforeError(new Error('x'));
}
`);
    const store = await indexed();

    expect(store.callers('Request._beforeError').filter((r) => r.guess === 0)).toEqual([]);
    expect(store.callers('Other._beforeError').filter((r) => r.guess === 0)).toEqual([]);
    store.close();
  }, 30000);

  it('works in plain JavaScript too', async () => {
    write('lib/a.js', `export class Request {
  _beforeError(error) {
    return error;
  }
}

export class Other {
  _beforeError(error) {
    return error;
  }
}

export function makeRequest(firstRequest) {
  const request = firstRequest ?? new Request();
  request._beforeError(new Error('x'));
}
`);
    const store = await indexed();

    expect(store.callers('Request._beforeError').map((n) => n.qname)).toEqual(['makeRequest']);
    store.close();
  }, 30000);
});
