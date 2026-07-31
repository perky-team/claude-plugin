import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-unres-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(rel, src) {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
}

// Fixture in the shape that made the graph lie: one method name on two types,
// reached through an interface field, a function parameter and a local variable.
// None of those three shapes can be typed, so each call site stays unresolved —
// and the graph must SAY so instead of answering "no callers".
function writeAmbiguousFixture() {
  write('internal/store/store.go', `package store
type Store interface {
	ListGroups() []string
}
`);
  write('internal/store/pg.go', `package store
type Postgres struct{}
func (p *Postgres) ListGroups() []string { return nil }
`);
  write('internal/store/mem.go', `package store
type Memory struct{}
func (m *Memory) ListGroups() []string { return nil }
`);
  // Call sites at lines 7 (interface field), 8 (concrete field — resolves),
  // 9 (parameter) and 12 (local variable).
  write('internal/api/server.go', `package api
import "x/internal/store"
type Server struct {
	store store.Store
	pg    *store.Postgres
}
func (s *Server) HandleList() []string { return s.store.ListGroups() }
func (s *Server) HandleTyped() []string { return s.pg.ListGroups() }
func Serve(st store.Store) []string { return st.ListGroups() }
func ServeLocal() []string {
	p := &store.Postgres{}
	return p.ListGroups()
}
`);
  // A second layer: HandleTyped is itself called through an interface field and
  // its name is ambiguous, so the call at line 7 is where an impact walk stops.
  write('internal/http/router.go', `package http
type Handler interface {
	HandleTyped() []string
}
type Other struct{}
func (o *Other) HandleTyped() []string { return nil }
type Router struct { srv Handler }
func (r *Router) Route() []string { return r.srv.HandleTyped() }
`);
}

describe('unresolved call-site reporting', () => {
  it('counts call edges and unresolved ones in status', async () => {
    writeAmbiguousFixture();
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    const st = store.status();
    // 4 ListGroups call sites + 1 HandleTyped call site; only the
    // concrete-field one (s.pg.ListGroups) can be typed.
    expect(st.call_edges).toBe(5);
    expect(st.unresolved_calls).toBe(4);

    store.close();
  }, 30000);

  it('lists the ambiguous call sites that name a target', async () => {
    writeAmbiguousFixture();
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // Asking by qname must still surface the call sites left bare: they carry
    // the target's bare name, which is exactly why they could not be attributed.
    const rows = store.unresolvedFor('store.Postgres.ListGroups');
    expect(rows.map((r) => `${r.file}:${r.line}`)).toEqual([
      'internal/api/server.go:7',
      'internal/api/server.go:9',
      'internal/api/server.go:12',
    ]);
    expect(rows[0].src_qname).toBe('api.Server.HandleList');
    expect(rows[0].dst_name).toBe('ListGroups');
    // The bare name works too — that is what a user usually types.
    expect(store.unresolvedFor('ListGroups')).toHaveLength(3);
    // A symbol nothing calls ambiguously reports nothing.
    expect(store.unresolvedFor('api.Serve')).toEqual([]);

    store.close();
  }, 30000);

  it('lists the unresolved calls a symbol makes', async () => {
    writeAmbiguousFixture();
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    const rows = store.unresolvedFrom('api.Server.HandleList');
    expect(rows).toHaveLength(1);
    expect(rows[0].dst_name).toBe('ListGroups');
    expect(rows[0].line).toBe(7);
    // The call that resolved is not reported as a gap.
    expect(store.unresolvedFrom('api.Server.HandleTyped')).toEqual([]);

    store.close();
  }, 30000);

  it('reports the gaps at the frontier of an impact set, not just at the target', async () => {
    writeAmbiguousFixture();
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // impact() walks resolved edges only: it reaches api.Server.HandleTyped and
    // stops, because HandleTyped's own caller is an unresolved interface call.
    expect(store.impact('store.Postgres.ListGroups').map((n) => n.qname))
      .toEqual(['api.Server.HandleTyped']);
    // The frontier report must include BOTH the target's own bare call sites and
    // the one where the walk stopped one level up.
    const rows = store.unresolvedAround('store.Postgres.ListGroups');
    expect(rows.map((r) => `${r.file}:${r.line}`)).toEqual([
      'internal/api/server.go:7',
      'internal/api/server.go:9',
      'internal/api/server.go:12',
      'internal/http/router.go:8',
    ]);

    store.close();
  }, 30000);
});
