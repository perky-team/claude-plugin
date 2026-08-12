import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
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
  dir = mkdtempSync(join(tmpdir(), 'pg-complete-'));
  mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });

// An answer with nothing missing used to end in silence. Measured on seven
// public repos, that silence costs money: in 12 of 27 runs the graph reported
// no gaps at all and the agent went and grepped anyway, because "no banner" and
// "I do not know" look identical. So a complete answer now says it is complete
// — and the rule template tells the reader that line means stop.
// See docs/measured-benefit.md.
describe('a complete answer says so', () => {
  const CHAIN = 'function foo() { bar(); }\nfunction bar() { baz(); }\nfunction baz() {}';
  // `x.m()` on an untyped receiver cannot be resolved to A.m, so it is reported
  // as a gap instead of guessed — one answer with something missing.
  const GAPPY = 'class A { m() {} }\nfunction run(x) { x.m(); }\n'
    + 'function direct() { const a = new A(); a.m(); }';

  it('callers with no gaps prints the line and sets complete in --json', () => {
    write('a.ts', CHAIN);
    run(['index', '--full']);

    expect(run(['callers', 'baz', '--stale-ok'])).toContain('✓ complete');
    expect(JSON.parse(run(['callers', 'baz', '--stale-ok', '--json'])).complete).toBe(true);
  }, 30000);

  it('callers with a gap keeps the warning and does NOT claim completeness', () => {
    write('a.ts', GAPPY);
    run(['index', '--full']);

    const text = run(['callers', 'A.m', '--stale-ok']);
    expect(text).toContain('1 call site missing from this answer');
    expect(text).not.toContain('✓ complete');
    expect(JSON.parse(run(['callers', 'A.m', '--stale-ok', '--json'])).complete).toBe(false);
  }, 30000);

  it('callees and context say it too', () => {
    write('a.ts', CHAIN);
    run(['index', '--full']);

    expect(run(['callees', 'bar', '--stale-ok'])).toContain('✓ complete');
    expect(run(['context', 'bar', '--stale-ok'])).toContain('✓ complete');
    expect(JSON.parse(run(['callees', 'bar', '--stale-ok', '--json'])).complete).toBe(true);
    expect(JSON.parse(run(['context', 'bar', '--stale-ok', '--json'])).complete).toBe(true);
  }, 30000);

  it('an empty answer with no gaps is complete — nothing calls this', () => {
    write('a.ts', 'function lonely() {}\nfunction other() {}');
    run(['index', '--full']);

    const text = run(['callers', 'lonely', '--stale-ok']);
    expect(text).toContain('✓ complete');
    expect(JSON.parse(run(['callers', 'lonely', '--stale-ok', '--json'])).callers).toEqual([]);
  }, 30000);

  it('impact says it when it refused nothing', () => {
    write('a.ts', CHAIN);
    run(['index', '--full']);

    expect(run(['impact', 'baz', '--stale-ok'])).toContain('✓ complete');
    expect(JSON.parse(run(['impact', 'baz', '--stale-ok', '--json'])).complete).toBe(true);
  }, 30000);

  // An impact walk that refused a guessed edge has left something out even with
  // an empty gap list. Its answer is a floor, and a floor is not complete.
  it('impact does NOT say it when it refused a guessed edge', () => {
    write('svc/svc.go', `package svc
type A struct{}
func (a *A) Guessed() {}
func Make() (*A, error) { return &A{}, nil }
func R1() { x, _ := Make(); x.Guessed() }
`);
    run(['index', '--full']);

    const json = JSON.parse(run(['impact', 'svc.A.Guessed', '--stale-ok', '--json']));
    expect(json.skipped_guesses).toBeGreaterThan(0);
    expect(json.complete).toBe(false);
    expect(run(['impact', 'svc.A.Guessed', '--stale-ok'])).not.toContain('✓ complete');
  }, 30000);

  // The dangerous case. On a database too old to build a gap report, the gap
  // list is empty because it cannot be built — not because nothing is missing.
  // Claiming completeness there would be the worst thing this line could do.
  it('never claims completeness when the gap report is unavailable', () => {
    write('a.ts', CHAIN);
    run(['index', '--full']);
    const w = openStore(join(dir, '.pgraph', 'graph.db'));
    w.db.exec('DROP INDEX IF EXISTS edges_dstbare');
    w.db.exec('ALTER TABLE edges DROP COLUMN dst_bare');
    w.close();

    const text = run(['callers', 'baz', '--stale-ok']);
    expect(text).toContain('the gap report needs a rebuilt graph');
    expect(text).not.toContain('✓ complete');
    const json = JSON.parse(run(['callers', 'baz', '--stale-ok', '--json']));
    expect(json.gaps_unavailable).toBe(true);
    expect(json.complete).toBe(false);
  }, 30000);
});
