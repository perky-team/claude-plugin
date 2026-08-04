import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

// Denies write access to `dir` itself (create/delete entries), leaving every
// existing file inside it readable — the shape of a genuinely read-only
// directory. Returns a function that undoes it; callers must run that before
// their own cleanup, or removing the temp dir afterwards fails too.
//
// Node's `chmod` on Windows only ever toggles the legacy DOS read-only
// attribute, which does not block creating files in a directory — so on
// win32 this uses `icacls` to deny the specific NTFS rights that do
// (WD = create file / write data, AD = create subdirectory / append data).
// Denying only those two, not the whole "write" bundle, keeps read and list
// access intact, matching what `chmod 0o555` does on POSIX.
function denyDirWrites(dir) {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME;
    execFileSync('icacls', [dir, '/deny', `${user}:(OI)(CI)(WD,AD)`], { stdio: 'pipe' });
    return () => execFileSync('icacls', [dir, '/remove:d', user], { stdio: 'pipe' });
  }
  chmodSync(dir, 0o555);
  return () => chmodSync(dir, 0o755);
}

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
    try {
      expect(ro.node('foo')).toBeTruthy();
      expect(ro.callers('bar').some((r) => r.name === 'foo')).toBe(true);
      expect(() => ro.setMeta('x', 'y')).toThrow(/read-only/);
      // The message itself must not carry its own "p-graph: " prefix: `die()`
      // in pgraph.mjs is the one place that adds it, and a message that
      // prefixes itself too printed as "pgraph: p-graph: store is read-only".
      let caught = null;
      try { ro.setMeta('x', 'y'); } catch (e) { caught = e; }
      expect(caught?.message).toBe('store is read-only');
    } finally {
      ro.close();
    }
  });

  // A read-only FILE already worked before this fix (WAL's -shm/-wal files
  // can still be created in the writable directory around it). A read-only
  // DIRECTORY is the case the fallback exists for and could not actually
  // serve: WAL mode needs to create a "-shm" file even just to read, and a
  // directory with no write access refuses that — every command died with
  // "unable to open database file".
  it('answers a query correctly when .pgraph is a read-only directory', () => {
    const undo = denyDirWrites(dir);
    let ro;
    try {
      ro = openStore(dbPath, { readOnly: true });
      expect(ro.node('foo')).toBeTruthy();
      expect(ro.callers('bar').some((r) => r.name === 'foo')).toBe(true);
    } finally {
      try { ro?.close(); } catch { /* a failed open leaves nothing to close */ }
      undo();
    }
  }, 20000);

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
