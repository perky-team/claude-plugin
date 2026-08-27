import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-graph/tools/pgraph.mjs');
let dir;
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });

// Asked about the interface method, the calls that run an implementation are
// knowledge, not a gap: the graph knows which type the receiver is and which
// method that call runs. They get their own heading for the same reason the
// interface-reach group does — a reader must not confuse "accounted for" with
// "go and grep for this".
describe('callers on an interface method', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pg-implreach-'));
    mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
    const write = (rel, src) => {
      const abs = join(dir, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, src);
    };
    // `Store` declares one method. `Postgres` implements it. `Cache` has a method
    // of the same name and a DIFFERENT shape — one parameter, no result — so it must
    // not be reported as an implementation.
    write('store/store.go', 'package store\ntype Store interface {\n\tListGroups() []string\n}\n');
    write('store/pg.go', 'package store\ntype Postgres struct{}\nfunc (p *Postgres) ListGroups() []string { return nil }\n');
    write('store/cache.go', 'package store\ntype Cache struct{}\nfunc (c *Cache) ListGroups(reset bool) { }\n');
    // A call on the concrete type, and a call on the differently shaped method.
    write('api/api.go', 'package api\nimport "x/store"\nfunc Serve() []string {\n\tpg := &store.Postgres{}\n\treturn pg.ListGroups()\n}\n');
    write('api/other.go', 'package api\nimport "x/store"\nfunc Warm() {\n\tc := &store.Cache{}\n\tc.ListGroups(true)\n}\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports the calls that run an implementation, under their own heading', () => {
    run(['index', '--full']);

    const out = run(['callers', 'store.Store.ListGroups']);
    // Substring only, not the full heading: it must survive the singular vs
    // plural noun ("call site" / "call sites"). The heading must say these
    // ARE call sites of the method (not read as an aside about some other,
    // adjacent thing) — that is what distinguishes it from the interface-reach
    // heading, which says the opposite: no call names this method directly.
    expect(out).toContain('of this method — on');
    expect(out).toContain('which implements it');
    expect(out).toContain('store.Postgres.ListGroups');
    expect(out).toContain('api/api.go:5');
    expect(out).not.toContain('missing from this answer');
  }, 30000);

  it('refuses a same-named method whose shape is different', () => {
    run(['index', '--full']);

    const out = run(['callers', 'store.Store.ListGroups']);
    expect(out).not.toContain('store.Cache.ListGroups');
    expect(out).not.toContain('api/other.go');
  }, 30000);

  it('carries the rows in --json under their own reason', () => {
    run(['index', '--full']);

    const parsed = JSON.parse(run(['callers', 'store.Store.ListGroups', '--json']));
    const rows = (parsed.gaps ?? []).filter((r) => r.reason === 'implementation');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.via)).toContain('store.Postgres.ListGroups');
    expect(rows.map((r) => `${r.file}:${r.line}`)).toContain('api/api.go:5');
  }, 30000);
});

// Two implementations of the same interface, called on the SAME source line —
// `append(p.ListGroups(), m.ListGroups()...)`. A dedup key built from only
// `file` and `line` cannot tell these two calls apart and keeps just one,
// silently dropping the other. Both calls are real; both must be named, each
// under its own implementing type.
describe('two implementations called on one line', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pg-implreach-oneline-'));
    mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
    const write = (rel, src) => {
      const abs = join(dir, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, src);
    };
    write('store/store.go', 'package store\ntype Store interface {\n\tListGroups() []string\n}\n');
    write('store/pg.go', 'package store\ntype Postgres struct{}\nfunc (p *Postgres) ListGroups() []string { return nil }\n');
    write('store/mem.go', 'package store\ntype Memory struct{}\nfunc (m *Memory) ListGroups() []string { return nil }\n');
    write('api/api.go', 'package api\nimport "x/store"\n'
      + 'func Serve(p *store.Postgres, m *store.Memory) []string {\n'
      + '\treturn append(p.ListGroups(), m.ListGroups()...)\n}\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('names both implementing types, each with its own via', () => {
    run(['index', '--full']);

    const parsed = JSON.parse(run(['callers', 'store.Store.ListGroups', '--json']));
    const rows = (parsed.gaps ?? [])
      .filter((r) => r.reason === 'implementation' && r.file === 'api/api.go' && r.line === 4);
    expect(rows.map((r) => r.via).sort()).toEqual([
      'store.Memory.ListGroups',
      'store.Postgres.ListGroups',
    ]);
  }, 30000);

  it('names both in the printed report too', () => {
    run(['index', '--full']);

    const out = run(['callers', 'store.Store.ListGroups']);
    expect(out).toContain('store.Postgres.ListGroups');
    expect(out).toContain('store.Memory.ListGroups');
    expect(out).not.toContain('missing from this answer');
  }, 30000);
});
