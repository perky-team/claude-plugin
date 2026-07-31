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
    expect(text).toContain('1 call site missing from this answer');
    expect(text).toContain('internal/api/server.go:6');
    expect(text).toContain('api.Server.HandleList -> ListGroups');
    expect(text).toContain('Confirm with a text search');
  }, 30000);

  it('carries the gaps in --json for callers, callees and impact', () => {
    run(['index', '--full']);
    const callers = JSON.parse(run(['callers', 'store.Postgres.ListGroups', '--json']));
    expect(callers.callers).toEqual([]);
    expect(callers.gaps).toHaveLength(1);
    expect(callers.gaps[0]).toMatchObject({
      file: 'internal/api/server.go', line: 6, dst_name: 'ListGroups',
      src_qname: 'api.Server.HandleList',
    });

    const callees = JSON.parse(run(['callees', 'api.Server.HandleList', '--json']));
    expect(callees.callees).toEqual([]);
    expect(callees.gaps).toHaveLength(1);
    expect(callees.gaps[0].dst_name).toBe('ListGroups');

    const impact = JSON.parse(run(['impact', 'store.Postgres.ListGroups', '--json']));
    expect(impact.impact).toEqual([]);
    expect(impact.gaps).toHaveLength(1);
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

  it('lists likely gaps and only counts the noisy ones', () => {
    // logs.Adapter.Errorf shares its name with testing.T.Errorf, called from a
    // package that never imports logs/. A second unrelated Errorf method keeps
    // the bare name ambiguous across the repo — a real repo the size of hugo has
    // many such names, so a call resolver never treats "Errorf" as unique there.
    // With only one candidate, the resolver would link t.Errorf to it directly
    // as a real (wrong) call edge, and the row would never reach the gap report.
    write('logs/logs.go', `package logs
type Adapter struct{}
func (a *Adapter) Errorf(f string, v ...any) {}
`);
    write('other/other.go', `package other
type Thing struct{}
func (t *Thing) Errorf(f string, v ...any) {}
`);
    write('far/far_test.go', `package far
import "testing"
func TestA(t *testing.T) { t.Errorf("a") }
func TestB(t *testing.T) { t.Errorf("b") }
`);
    run(['index', '--full']);
    const text = run(['callers', 'logs.Adapter.Errorf']);
    expect(text).toContain('2 same-name call sites in files that do not import');
    expect(text).not.toContain('far/far_test.go:3');   // counted, not listed
    expect(text).not.toContain('far/far_test.go:4');
  }, 30000);

  it('counts calls that leave the repo without listing them', () => {
    write('svc/svc.go', `package svc
import "fmt"
func Do() { fmt.Println("x") }
`);
    run(['index', '--full']);
    const text = run(['callees', 'svc.Do']);
    expect(text).toContain('1 call that leaves the repo');
    expect(text).not.toContain('svc/svc.go:3');
  }, 30000);

  it('moves a stdlib call out of the listed gaps even when a repo method shares its bare name', () => {
    // fmt.Errorf and a repo method logs.Adapter.Errorf share the bare name
    // "Errorf". Before the qualifier fix, this made fmt.Errorf show up as a
    // "may be a real miss" gap, which it never can be — the call site wrote
    // "fmt", and no repo package is named "fmt".
    write('logs/logs.go', `package logs
type Adapter struct{}
func (a *Adapter) Errorf(f string, v ...any) {}
`);
    write('other/other.go', `package other
type Thing struct{}
func (t *Thing) Errorf(f string, v ...any) {}
`);
    write('caller/caller.go', `package caller
import "fmt"
func Do() { fmt.Errorf("x") }
`);
    run(['index', '--full']);
    const text = run(['callers', 'logs.Adapter.Errorf']);
    expect(text).not.toContain('caller/caller.go');
    expect(text).not.toContain('missing from this answer');
    expect(text).toContain('1 call that leaves the repo');
  }, 30000);

  it('names a resolved call site that has no caller row', () => {
    write('web/engine.ts', 'export class Engine { start() {} }');
    write('web/boot.ts', "import { Engine } from './engine';\nnew Engine().start();");
    run(['index', '--full']);
    const text = run(['callers', 'Engine.start']);
    expect(text).toContain('web/boot.ts:2');
    expect(text).toContain('outside any indexed symbol');
  }, 30000);

  it('scores a frontier gap against the package that actually matched it, not the impact target', () => {
    // a.Root <- b.CallsRoot <- b.X.Mid: a chain of RESOLVED calls, so
    // impact('a.Root') reaches both CallsRoot and Mid.
    write('a/a.go', `package a
func Root() {}
`);
    write('b/mid.go', `package b
import "x/a"
type X struct{}
func (x *X) Mid() { CallsRoot() }
func CallsRoot() { a.Root() }
`);
    // A same-name (ambiguous) call to "Mid" in package b itself — through an
    // interface field, so it stays unresolved. Package c gives "Mid" a second
    // repo candidate so the bare name is not unique and Pass B cannot resolve it.
    write('b/caller.go', `package b
type Iface interface { Mid() }
type Caller struct { v Iface }
func (c *Caller) DoMid() { c.v.Mid() }
`);
    write('c/c.go', `package c
type Z struct{}
func (z *Z) Mid() {}
`);
    run(['index', '--full']);

    // Asked directly (callers b.X.Mid), the gap is scored against Mid's own
    // package, "b" — caller.go is in package b, so reachable is 1.
    const callersGaps = JSON.parse(run(['callers', 'b.X.Mid', '--json'])).gaps;
    const callersRow = callersGaps.find((g) => g.file === 'b/caller.go');
    expect(callersRow).toBeTruthy();
    expect(callersRow.reachable).toBe(1);

    // Asked as the frontier of an impact walk from a.Root, the SAME call site
    // must be scored the same way — against "b" (Mid's package), not "a"
    // (Root's package, which caller.go neither belongs to nor imports).
    const impactGaps = JSON.parse(run(['impact', 'a.Root', '--json'])).gaps;
    const impactRow = impactGaps.find((g) => g.file === 'b/caller.go');
    expect(impactRow).toBeTruthy();
    expect(impactRow.reachable).toBe(1);
  }, 30000);
});
