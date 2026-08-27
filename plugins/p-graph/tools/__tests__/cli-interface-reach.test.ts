import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-graph/tools/pgraph.mjs');
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-ifacecli-'));
  mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
  const write = (rel, src) => {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, src);
  };
  write('store/store.go', 'package store\ntype Store interface {\n\tListGroups() []string\n}\n');
  write('store/pg.go', 'package store\ntype Postgres struct{}\nfunc (p *Postgres) ListGroups() []string { return nil }\n');
  write('api/api.go', 'package api\nimport "x/store"\nfunc Serve(st store.Store) []string { return st.ListGroups() }\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });

// The two claims must not share a heading. "missing from this answer" means the
// graph knows it is short and the reader has to grep. "reached through an
// interface" means the opposite: the graph accounted for the call and knows
// exactly which interface carries it — there is nothing to grep for.
describe('callers on a method an interface reaches', () => {
  it('reports it under its own heading, not as a missing call site', () => {
    run(['index', '--full']);

    const out = run(['callers', 'store.Postgres.ListGroups']);
    // Substring only, not the full heading: it must survive both the singular
    // and plural verb form ("call site reaches" / "call sites reach").
    expect(out).toContain('this method through store.Store.ListGroups');
    expect(out).toContain('api/api.go:3');
    expect(out).not.toContain('missing from this answer');
    // The static answer really is complete: no call names this method.
    expect(out).toContain('✓ complete');
  }, 30000);

  it('carries it in --json under its own reason', () => {
    run(['index', '--full']);

    const j = JSON.parse(run(['callers', 'store.Postgres.ListGroups', '--json']));
    expect(j.complete).toBe(true);
    expect(j.gaps).toEqual([{
      file: 'api/api.go', line: 3, dst_name: 'ListGroups', src_qname: 'api.Serve',
      reason: 'interface', reachable: 1, via: 'store.Store.ListGroups',
    }]);
  }, 30000);

  it('leaves the interface method\'s own answer alone', () => {
    run(['index', '--full']);

    const out = run(['callers', 'store.Store.ListGroups']);
    expect(out).toContain('api/api.go:3');
    expect(out).toContain('✓ complete');
    expect(out).not.toContain('this method through');
  }, 30000);
});
