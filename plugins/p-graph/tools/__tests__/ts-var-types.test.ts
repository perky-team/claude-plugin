import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-tsvar-')); });
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

describe('a call on a TypeScript name carries that name as its key', () => {
  it('keys a member call on a parameter', async () => {
    write('app.ts', `export class Conn {
  query(q: string) { return q; }
}
export function read(c: Conn) {
  return c.query('1');
}
`);
    const s = await indexed();

    const row = s.db.prepare(
      `SELECT field_key, method FROM edges WHERE kind = 'call' AND dst_bare = 'query'`).get();
    expect(row.method).toBe('query');
    expect(row.field_key).toMatch(/#var:c@/);

    s.close();
  }, 30000);

  it('does not key a call on this, or on an attribute path', async () => {
    write('app.ts', `export class Conn {
  query(q: string) { return q; }
  run() { return this.query('1'); }
}
export function read(w: { c: Conn }) {
  return w.c.query('1');
}
`);
    const s = await indexed();

    const rows = s.db.prepare(
      `SELECT field_key FROM edges WHERE kind = 'call' AND dst_bare = 'query'`).all();
    // `this.query()` is answered by the self-call rule, and `w.c.query()` is written
    // on an attribute — neither is a call on a plain bound name.
    expect(rows.every((r) => r.field_key === null)).toBe(true);

    s.close();
  }, 30000);

  it('keys the inner binding when two scopes bind one name', async () => {
    write('app.ts', `export class Conn {
  query(q: string) { return q; }
}
export function outer(c: Conn) {
  function inner(c: Conn) {
    return c.query('inner');
  }
  return inner(c) + c.query('outer');
}
`);
    const s = await indexed();

    const rows = s.db.prepare(
      `SELECT line, field_key FROM edges WHERE kind = 'call' AND dst_bare = 'query' ORDER BY line`).all();
    expect(rows).toHaveLength(2);
    // Two different bindings of `c`, so two different keys.
    expect(rows[0].field_key).not.toBe(rows[1].field_key);

    s.close();
  }, 30000);
});

describe('a TypeScript type stated in the source', () => {
  it('resolves a call on an annotated parameter, and calls it certain', async () => {
    write('app.ts', `export class Conn {
  query(q: string) { return q; }
}
export class Decoy {
  query(q: string) { return q; }
}
export function read(c: Conn) {
  return c.query('1');
}
`);
    const s = await indexed();

    // Two classes share the method name, so a bare name cannot answer this at all.
    expect(s.callers('Conn.query')).toMatchObject([{ qname: 'read', guess: 0 }]);
    expect(s.callers('Decoy.query')).toEqual([]);

    s.close();
  }, 30000);

  it('resolves a call on an annotated variable and on a new expression', async () => {
    write('app.ts', `export class Conn {
  query(q: string) { return q; }
}
export function fromAnnotation() {
  const c: Conn = build();
  return c.query('1');
}
export function fromNew() {
  const c = new Conn();
  return c.query('1');
}
function build(): any { return null; }
`);
    const s = await indexed();

    expect(s.callers('Conn.query').map((r) => r.qname).sort())
      .toEqual(['fromAnnotation', 'fromNew']);
    expect(s.callers('Conn.query').every((r) => r.guess === 0)).toBe(true);

    s.close();
  }, 30000);

  it('does not treat a function\'s own generic type parameter as a stated type', async () => {
    write('app.ts', `export class T {
  logic() { return 1; }
}
export function f<T>(x: T) {
  return x.logic();
}
`);
    const s = await indexed();

    // f's <T> is a placeholder for whatever type its caller passes in — not the
    // class also named T. A name collision like this must never turn into a
    // CERTAIN edge: that is exactly the false-knowledge bug this feature exists
    // to remove. A guessed edge (the honest bare-name fallback) is fine; a
    // certain one is not.
    const rows = s.callers('T.logic');
    expect(rows.some((r) => r.qname === 'f' && r.guess === 0)).toBe(false);

    s.close();
  }, 30000);

  it('does not treat a class or method type parameter as a stated type either', async () => {
    write('app.ts', `export class T {
  logic() { return 1; }
}
export class Box<T> {
  put(x: T) { return x.logic(); }
}
export class Crate {
  put2<T>(x: T) { return x.logic(); }
}
`);
    const s = await indexed();

    // The same collision, but bound by a generic class and by a generic method
    // instead of a generic function — the walk that refuses the name must not
    // stop at the nearest function.
    const rows = s.callers('T.logic');
    expect(rows.some((r) => r.qname === 'Box.put' && r.guess === 0)).toBe(false);
    expect(rows.some((r) => r.qname === 'Crate.put2' && r.guess === 0)).toBe(false);

    s.close();
  }, 30000);

  it('refuses a guess when the annotation names a type from outside the repo', async () => {
    write('app.ts', `import { ServerResponse } from 'node:http';
export class Sink {
  setHeader(k: string, v: string) {}
}
export function send(res: ServerResponse) {
  res.setHeader('a', 'b');
}
`);
    const s = await indexed();

    // ServerResponse is not ours, so the one repo method named setHeader must not
    // claim the call...
    expect(s.callers('Sink.setHeader')).toEqual([]);
    // ...and the call site is named instead of dropped.
    expect(s.gapsFor('Sink.setHeader').length).toBeGreaterThan(0);

    s.close();
  }, 30000);
});
