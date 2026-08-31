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
func Make() (*A, error) { return &A{}, nil }
func R1() { x, _ := Make(); x.Guessed() }
func R2() { y, _ := Make(); y.Guessed() }
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

  // A call written at file scope is a LEAF of the impact walk now: nothing calls a
  // top-level statement, so it ends the chain, but it still breaks when the target
  // changes. That makes a GUESSED one a path the walk refuses, exactly like a
  // guessed edge that does have a caller — so it is counted here.
  //
  // It used to be counted nowhere and reported as a `no-caller` gap row instead.
  // That row is gone: `impact` lists the certain file-scope calls itself, and
  // naming a listed line under ⚠ made one answer contradict itself. The count is
  // what keeps the refused ones honest — without it this answer would be an empty
  // list plus `✓ complete`, over a real call site the graph could not settle.
  it('counts a guessed file-scope call as a path it refused', () => {
    write('svc/svc.go', `package svc
type A struct{}
func (a *A) Guessed() {}
func Make() (*A, error) { return &A{}, nil }
var eager = func() *A { x, _ := Make(); x.Guessed(); return x }()
`);
    run(['index', '--full']);

    const json = JSON.parse(run(['impact', 'svc.A.Guessed', '--json']));
    // The one path in is a guess, so the walk refuses it and the list stays empty.
    expect(json.impact).toEqual([]);
    // No longer a gap row — the count below is where it is reported.
    expect(json.gaps.some((g) => g.reason === 'no-caller')).toBe(false);
    expect(json.skipped_guesses).toBe(1);
    // A refused edge disqualifies the completeness claim on its own.
    expect(json.complete).toBe(false);

    const text = run(['impact', 'svc.A.Guessed']);
    expect(text).toContain('1 guessed edge');
    expect(text).toContain('was not followed');
    expect(text).not.toContain('✓ complete');
  }, 30000);

  // The other half of the same rule: a file-scope call the resolver settled is
  // CERTAIN, so `impact` lists it as a leaf. `a := &A{}` writes the receiver's
  // type at the call site, so nothing here is a guess.
  it('lists a certain file-scope call as a leaf of the walk', () => {
    write('svc/svc.go', `package svc
type A struct{}
func (a *A) Certain() {}
var eager = func() *A { a := &A{}; a.Certain(); return a }()
`);
    run(['index', '--full']);

    const json = JSON.parse(run(['impact', 'svc.A.Certain', '--json']));
    const fileRow = json.impact.find((r) => r.kind === 'file');
    expect(fileRow).toBeTruthy();
    expect(fileRow.qname).toBe('svc/svc.go');
    expect(fileRow.call_sites.map((s) => s.line)).toEqual([4]);
    expect(json.skipped_guesses).toBe(0);
    expect(json.gaps.some((g) => g.reason === 'no-caller')).toBe(false);

    const text = run(['impact', 'svc.A.Certain']);
    expect(text).toContain('file svc/svc.go  4');
    expect(text).not.toContain('(no impact)');
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
