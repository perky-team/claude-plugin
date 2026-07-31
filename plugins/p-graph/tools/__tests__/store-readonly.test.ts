import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

describe('read-only store open', () => {
  let dir, dbPath;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pg-'));
    dbPath = join(dir, 'graph.db');
    writeFileSync(join(dir, 'a.ts'), 'function foo() { bar(); }\nfunction bar() {}');
    const w = openStore(dbPath);
    await indexFull({ root: dir, store: w, ignorePatterns: [] });
    w.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('serves queries and rejects writes', () => {
    const ro = openStore(dbPath, { readOnly: true });
    expect(ro.node('foo')).toBeTruthy();
    expect(ro.callers('bar').some((r) => r.name === 'foo')).toBe(true);
    expect(() => ro.setMeta('x', 'y')).toThrow(/read-only/);
    ro.close();
  });

  it('opens a pre-6 database read-only and still answers queries that do not need the new columns', async () => {
    // A schema-4 DB has no edges.dst_bare/lang/external and no field_types
    // "#embed" rows. attachReadHelpers used to prepare gapRows (and its
    // siblings) EAGERLY, naming e.dst_bare/e.lang/e.external — that statement
    // failed to prepare on an older DB, so the whole read-only open threw and
    // the writable-open error (e.g. a read-only filesystem) won the fallback
    // race, killing the CLI instead of degrading gracefully.
    const oldDbPath = join(dir, 'old.db');
    const w = openStore(oldDbPath);
    await indexFull({ root: dir, store: w, ignorePatterns: [] });
    w.setMeta('schema_version', '4');
    w.db.exec('DROP INDEX edges_dstbare'); // the column it covers is about to go
    w.db.exec('ALTER TABLE edges DROP COLUMN dst_bare');
    w.db.exec('ALTER TABLE edges DROP COLUMN lang');
    w.db.exec('ALTER TABLE edges DROP COLUMN external');
    w.close();

    const ro = openStore(oldDbPath, { readOnly: true });
    expect(ro.node('foo')).toBeTruthy();
    expect(ro.callers('bar').some((r) => r.name === 'foo')).toBe(true);
    ro.close();
  });
});
