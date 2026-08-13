import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-thisclosure-')); });
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

// `this.m()` written inside a method resolves to that method's class. Written
// one level deeper — inside an arrow function inside the method — it did not:
// the innermost definition is the arrow, and its container is the method, not
// the class, so the owner lookup stopped and the call fell to a bare-name
// guess. An arrow function does not rebind `this`; a plain `function` does.
// Measured on got: `Request._onRequest`'s error handler is written that way, and
// its `this._beforeError(...)` sat in the UNVERIFIED block of a 25-row answer.
describe('a call on this inside a closure', () => {
  it('belongs to the class, in TypeScript', async () => {
    write('src/index.ts', `export class Request {
  _beforeError(error: Error) {
    return error;
  }

  _onRequest() {
    const emitRequestError = (error: Error) => {
      this._beforeError(error);
    };
    return emitRequestError;
  }
}

export class Other {
  _beforeError(error: Error) {
    return error;
  }
}
`);
    const store = await indexed();

    const rows = store.callers('Request._beforeError');
    expect(rows.length).toBe(1);
    expect(rows.every((r) => r.guess === 0)).toBe(true);
    expect(store.callers('Other._beforeError')).toEqual([]);
    store.close();
  }, 30000);

  it('belongs to the class in plain JavaScript too', async () => {
    write('lib/req.js', `export class Request {
  _beforeError(error) {
    return error;
  }

  _onRequest() {
    const emitRequestError = (error) => {
      this._beforeError(error);
    };
    return emitRequestError;
  }
}

export class Other {
  _beforeError(error) {
    return error;
  }
}
`);
    const store = await indexed();

    expect(store.callers('Request._beforeError').length).toBe(1);
    expect(store.callers('Other._beforeError')).toEqual([]);
    store.close();
  }, 30000);

  it('reaches through an arrow passed as a callback', async () => {
    write('src/index.ts', `declare function run(cb: (e: Error) => void): void;

export class Request {
  _beforeError(error: Error) {
    return error;
  }

  _onRequest() {
    run((error: Error) => {
      this._beforeError(error);
    });
  }
}

export class Other {
  _beforeError(error: Error) {
    return error;
  }
}
`);
    const store = await indexed();

    expect(store.callers('Request._beforeError').length).toBe(1);
    expect(store.callers('Request._beforeError').every((r) => r.guess === 0)).toBe(true);
    store.close();
  }, 30000);

  it('does NOT reach through a plain function expression, which rebinds this', async () => {
    // `function () { this… }` gets its own `this`. Claiming the class here
    // would be a false certain row, which is the worst kind.
    write('src/index.ts', `declare function run(cb: (e: Error) => void): void;

export class Request {
  _beforeError(error: Error) {
    return error;
  }

  _onRequest() {
    run(function (error: Error) {
      // @ts-expect-error deliberately the wrong this
      this._beforeError(error);
    });
  }
}

export class Other {
  _beforeError(error: Error) {
    return error;
  }
}
`);
    const store = await indexed();

    // Two classes own the name, so with `this` refused there is nothing left to
    // match and the row is not claimed at all. What must never happen is a
    // CERTAIN row naming Request — that would be knowledge the source denies.
    expect(store.callers('Request._beforeError').filter((r) => r.guess === 0)).toEqual([]);
    expect(store.callers('Other._beforeError').filter((r) => r.guess === 0)).toEqual([]);
    store.close();
  }, 30000);

  it('reaches through a nested def in Python, which closes over self', async () => {
    write('app/a.py', `class A:
    def other(self):
        return 1

    def m(self):
        def inner():
            self.other()
        return inner


class B:
    def other(self):
        return 2
`);
    const store = await indexed();

    expect(store.callers('A.other').length).toBe(1);
    expect(store.callers('A.other').every((r) => r.guess === 0)).toBe(true);
    expect(store.callers('B.other')).toEqual([]);
    store.close();
  }, 30000);
});
