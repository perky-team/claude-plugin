import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';

const CLI = join(process.cwd(), 'plugins/p-graph/tools/pgraph.mjs');
let dir;
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-degrade-'));
  mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => spawnSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });

// A forgotten argument used to reach SQLite as an unbound parameter, so the user
// got `pgraph: Provided value cannot be bound to SQLite parameter 1.` and exit 3
// — a database error for a typo. `search` always had the right check.
describe('a missing argument says what is missing', () => {
  const NEEDS_A_SYMBOL = ['callers', 'callees', 'impact', 'context', 'node'];
  for (const cmd of NEEDS_A_SYMBOL) {
    it(`${cmd} with no symbol`, () => {
      write('a.ts', 'export function foo() {}');
      run(['index', '--full']);
      const r = run([cmd]);
      expect(r.stderr).toContain(`${cmd} needs a symbol`);
      expect(r.stderr).not.toContain('SQLite');
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
    }, 30000);
  }

  it('trace names both ends', () => {
    write('a.ts', 'export function foo() { bar(); }\nexport function bar() {}');
    run(['index', '--full']);

    expect(run(['trace']).stderr).toContain('trace needs two symbols');
    const one = run(['trace', 'foo']);
    expect(one.stderr).toContain('trace needs two symbols');
    expect(one.stderr).not.toContain('SQLite');
    expect(one.status).toBe(1);
    // Both ends given: the command works as before.
    expect(run(['trace', 'foo', 'bar']).status).toBe(0);
  }, 30000);
});

// The read-only fallback exists for a filesystem that can never be migrated, so
// on a pre-schema-6 database it is the ONE path that has to answer from old
// columns. The gap-report statements name e.dst_bare, which such a database does
// not have, so `callers`, `callees`, `impact` and `context` died with
// `no such column: e.dst_bare` — in exactly the situation the fallback is for.
describe('a database too old for the gap report still answers', () => {
  const openOld = () => {
    const dbPath = join(dir, '.pgraph', 'graph.db');
    const w = openStore(dbPath);
    // A schema-5 shape. The index has to go first: SQLite refuses to drop a
    // column an index still names.
    w.db.exec('DROP INDEX IF EXISTS edges_dstbare');
    w.db.exec('ALTER TABLE edges DROP COLUMN dst_bare');
    w.close();
    return openStore(dbPath, { readOnly: true });
  };

  it('answers the rows it has, and says the gap report is unavailable', () => {
    write('a.ts', 'export function foo() { bar(); }\nexport function bar() {}');
    run(['index', '--full']);
    const ro = openOld();

    expect(ro.callers('bar').map((r) => r.qname)).toEqual(['foo']);
    expect(ro.impact('bar').map((r) => r.qname)).toEqual(['foo']);
    // No gap rows are possible here, and that is NOT the same as "no gaps".
    expect(ro.gapsFor('bar')).toEqual([]);
    expect(ro.gapsFrom('foo')).toEqual([]);
    expect(ro.gapsAround('bar')).toEqual([]);
    expect(ro.gapsUnavailable).toBe(true);

    ro.close();
  }, 30000);

  it('a current database does not claim the gap report is unavailable', () => {
    write('a.ts', 'export function foo() { bar(); }\nexport function bar() {}');
    run(['index', '--full']);
    const store = openStore(join(dir, '.pgraph', 'graph.db'), { readOnly: true });
    expect(store.gapsUnavailable).toBe(false);
    store.close();
  }, 30000);
});
