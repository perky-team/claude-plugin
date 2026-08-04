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
  dir = mkdtempSync(join(tmpdir(), 'pg-skip-'));
  mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });

describe('impact --json says WHY an empty answer is empty', () => {
  it('reports a skipped_guesses count, not just a boolean, when every path in is a guess', () => {
    // Two call sites reach A.Guessed only through a local typed from a
    // function's return value -- a shape the graph does not track -- so
    // each links via the unique-bare-name guess (Pass B), never a certain
    // pass. Two of them, so a reader can tell a real count from a flag.
    write('svc/svc.go', `package svc
type A struct{}
func (a *A) Guessed() {}
func Make() *A { return &A{} }
func R1() { x := Make(); x.Guessed() }
func R2() { y := Make(); y.Guessed() }
`);
    run(['index', '--full']);

    const json = JSON.parse(run(['impact', 'svc.A.Guessed', '--json']));
    // Nothing was walked -- both paths in are refused -- but that is a
    // different claim from "nothing calls this at all", and skipped_guesses
    // is what tells the two apart.
    expect(json.impact).toEqual([]);
    expect(json.skipped_guesses).toBe(2);

    const text = run(['impact', 'svc.A.Guessed']);
    expect(text).toContain('(no impact)');
    expect(text).toContain('2 guessed edges');
    expect(text).toContain('were not followed');
  }, 30000);

  // `impact` walks `e.src_id IS NOT NULL` only: an edge with no source symbol has
  // no caller to report, so the walk never had it to refuse. Counting it as a
  // skipped guess tells the reader a path was withheld when there was none —
  // and the same call is ALREADY reported, as a `no-caller` gap row.
  it('does not count a guess the walk would never have followed anyway', () => {
    write('svc/svc.go', `package svc
type A struct{}
func (a *A) Guessed() {}
func Make() *A { return &A{} }
var eager = func() *A { x := Make(); x.Guessed(); return x }()
`);
    run(['index', '--full']);

    const json = JSON.parse(run(['impact', 'svc.A.Guessed', '--json']));
    expect(json.impact).toEqual([]);
    // The one call site sits outside any indexed symbol, so it is a gap row...
    expect(json.gaps.some((g) => g.reason === 'no-caller')).toBe(true);
    // ...and must NOT also be counted as a path the walk refused.
    expect(json.skipped_guesses).toBe(0);

    const text = run(['impact', 'svc.A.Guessed']);
    expect(text).not.toContain('were not followed');
  }, 30000);

  it('reports skipped_guesses: 0 and drops the disclaimer when no guess is near the target', () => {
    write('a.ts', 'function foo() { bar(); }\nfunction bar() { baz(); }\nfunction baz() {}');
    run(['index', '--full']);

    const json = JSON.parse(run(['impact', 'baz', '--json']));
    expect(json.impact.map((r) => r.qname).sort()).toEqual(['bar', 'foo']);
    expect(json.skipped_guesses).toBe(0);

    const text = run(['impact', 'baz']);
    // The disclaimer is only true when a guess was actually skipped. With
    // none anywhere near this target, printing it unconditionally would be
    // noise -- always true, never informative -- so it must not appear.
    expect(text).not.toContain('were not followed');
    expect(text).not.toContain('guessed edge');
  }, 30000);
});
