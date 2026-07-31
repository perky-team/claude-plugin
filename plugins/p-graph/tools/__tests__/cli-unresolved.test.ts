import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-graph/tools/pgraph.mjs');
let dir;
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-gap-'));
  mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
  // ListGroups lives on two types and is called through an interface field, so
  // the call site cannot be attributed and the graph must say so.
  write('internal/store/pg.go', `package store
type Store interface {
	ListGroups() []string
}
type Postgres struct{}
func (p *Postgres) ListGroups() []string { return nil }
type Memory struct{}
func (m *Memory) ListGroups() []string { return nil }
`);
  write('internal/api/server.go', `package api
import "x/internal/store"
type Server struct {
	store store.Store
}
func (s *Server) HandleList() []string { return s.store.ListGroups() }
`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });

describe('cli reports where the graph gave up', () => {
  it('warns after an empty callers list instead of implying there are none', () => {
    run(['index', '--full']);
    const text = run(['callers', 'store.Postgres.ListGroups']);
    expect(text).toContain('1 unattributed call site');
    expect(text).toContain('internal/api/server.go:6');
    expect(text).toContain('api.Server.HandleList -> ListGroups');
    expect(text).toMatch(/may be incomplete/);
  }, 30000);

  it('carries the gaps in --json for callers, callees and impact', () => {
    run(['index', '--full']);
    const callers = JSON.parse(run(['callers', 'store.Postgres.ListGroups', '--json']));
    expect(callers.callers).toEqual([]);
    expect(callers.unresolved).toHaveLength(1);
    expect(callers.unresolved[0]).toMatchObject({
      file: 'internal/api/server.go', line: 6, dst_name: 'ListGroups',
      src_qname: 'api.Server.HandleList',
    });

    const callees = JSON.parse(run(['callees', 'api.Server.HandleList', '--json']));
    expect(callees.callees).toEqual([]);
    expect(callees.unresolved).toHaveLength(1);
    expect(callees.unresolved[0].dst_name).toBe('ListGroups');

    const impact = JSON.parse(run(['impact', 'store.Postgres.ListGroups', '--json']));
    expect(impact.impact).toEqual([]);
    expect(impact.unresolved).toHaveLength(1);
  }, 30000);

  it('shows the unattributed share in status', () => {
    run(['index', '--full']);
    expect(run(['status'])).toContain('unattributed calls 1/1');
    expect(JSON.parse(run(['status', '--json'])).unresolved_calls).toBe(1);
  }, 30000);

  it('says a missing trace path may be a gap, not proof of no path', () => {
    run(['index', '--full']);
    const text = run(['trace', 'api.Server.HandleList', 'store.Postgres.ListGroups']);
    expect(text).toContain('no path');
    expect(text).toContain('1/1');
  }, 30000);

  it('stays quiet when nothing was dropped', () => {
    write('clean.ts', 'function foo() { bar(); }\nfunction bar() {}');
    run(['index', '--full']);
    const text = run(['callers', 'bar']);
    expect(text).toContain('foo');
    expect(text).not.toContain('unattributed');
  }, 30000);
});
