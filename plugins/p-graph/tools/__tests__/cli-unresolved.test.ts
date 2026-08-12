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
  // ListGroups lives on two types and is called through an interface field. The
  // call now resolves — to the INTERFACE method, which is what the source names —
  // so it is no longer a gap for either concrete type. What each concrete type
  // gets instead is the `ℹ … reach this method through …` line: the same warning,
  // with the interface named. See interface-reach.test.ts for why that trade had
  // to be made deliberately rather than allowed to happen.
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
    expect(text).toContain('1 call site reach');
    expect(text).toContain('through store.Store.ListGroups');
    expect(text).toContain('internal/api/server.go:6');
    expect(text).toContain('api.Server.HandleList -> ListGroups');
    // No grep to do: the graph named the interface, which a text search cannot.
    expect(text).not.toContain('Confirm with a text search');
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

    // The call resolves now, so HandleList has a callee and no gap.
    const callees = JSON.parse(run(['callees', 'api.Server.HandleList', '--json']));
    expect(callees.callees.map((r) => r.qname)).toEqual(['store.Store.ListGroups']);
    expect(callees.gaps).toEqual([]);

    const impact = JSON.parse(run(['impact', 'store.Postgres.ListGroups', '--json']));
    expect(impact.impact).toEqual([]);
    expect(impact.gaps).toHaveLength(1);
    expect(impact.gaps[0].reason).toBe('interface');
  }, 30000);

  it('shows the unattributed share in status', () => {
    run(['index', '--full']);
    // Nothing is unattributed any more: the one call reaches the interface method.
    expect(run(['status'])).toContain('unattributed calls 0/1');
    expect(JSON.parse(run(['status', '--json'])).unresolved_calls).toBe(0);
  }, 30000);

  it('says a missing trace path may be a gap, not proof of no path', () => {
    run(['index', '--full']);
    // There is no static path to the CONCRETE method — the chain goes through the
    // interface — and with nothing unattributed the note has no share to quote.
    const text = run(['trace', 'api.Server.HandleList', 'store.Postgres.ListGroups']);
    expect(text).toContain('no path');
    // The path to the interface method is real and the trace finds it.
    expect(run(['trace', 'api.Server.HandleList', 'store.Store.ListGroups']))
      .toContain('store.Store.ListGroups');
  }, 30000);

  it('stays quiet when nothing was dropped', () => {
    write('clean.ts', 'function foo() { bar(); }\nfunction bar() {}');
    run(['index', '--full']);
    const text = run(['callers', 'bar']);
    expect(text).toContain('foo');
    // The banner text is "call sites missing from this answer" — "unattributed"
    // never appears in callers' output (only status/trace use that word), so
    // that assertion could never fail. Assert against the real banner text.
    expect(text).not.toContain('missing from this answer');
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
    // `testing.T` types both receivers, so the graph can prove neither is the
    // target: counted under the library line, not listed.
    expect(text).toContain('2 call sites whose receiver the source types as a library type');
    expect(text).not.toContain('far/far_test.go:3');   // counted, not listed
    expect(text).not.toContain('far/far_test.go:4');
  }, 30000);

  it('counts calls the graph found nothing to link to, without listing them', () => {
    write('svc/svc.go', `package svc
import "fmt"
func Do() { fmt.Println("x") }
`);
    run(['index', '--full']);
    const text = run(['callees', 'svc.Do']);
    expect(text).toContain('1 call the graph found nothing to link to');
    // Counted, not listed: no gap row for it. Asserted against the gap-row
    // shape (four spaces, then file:line) rather than the bare path — the
    // header line names svc.Do's own definition, which is a different claim.
    expect(text).not.toMatch(/^ {4}svc\/svc\.go:3\b/m);
    expect(text).not.toContain('call sites missing from this answer');
  }, 30000);

  it('does not claim a repo-type conversion "leaves the repo" — it never left', () => {
    // Duration(v) converts to a repo-defined type. It parses as a call, so it
    // lands in the same "nothing to link" bucket as a real external call —
    // but calling that bucket "leaves the repo" is a lie for this row: the
    // type IS in the repo, just not something a call can target.
    write('cfg/cfg.go', `package cfg
type Duration int64
func Parse(v int64) Duration { return Duration(v) }
`);
    run(['index', '--full']);
    const text = run(['callees', 'cfg.Parse']);
    expect(text).not.toContain('leaves the repo');
    expect(text).toContain('1 call the graph found nothing to link to');
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
    expect(text).toContain('1 call the graph found nothing to link to');
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
    // A same-name (ambiguous) call to "Mid" in package b itself. The receiver is a
    // field of a THIRD-PARTY type: the source states a type, so the bare-name
    // fallback is refused, and no repo symbol carries it, so nothing resolves.
    // (An interface field used to do this job. It no longer does — an interface
    // method is a symbol now and the call lands on it — and this test is about how
    // a frontier gap is SCORED, not about interfaces.) Package c gives "Mid" a
    // second repo candidate so the bare name is not unique either.
    write('b/caller.go', `package b
import "github.com/third/ext"
type Caller struct { v ext.Thing }
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
