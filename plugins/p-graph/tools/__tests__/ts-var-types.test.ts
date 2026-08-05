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
