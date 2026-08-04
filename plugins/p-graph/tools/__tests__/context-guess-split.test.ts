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
  dir = mkdtempSync(join(tmpdir(), 'pg-ctxsplit-'));
  mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
  // A.Guessed has two callers: UseTyped's `a` is a typed parameter (Pass F,
  // certain), UseUntyped's `x` is typed from a call's return value, a shape
  // the graph does not track, so it only links through the unique-bare-name
  // guess (Pass B). One target, one certain caller, one guessed caller.
  write('svc/svc.go', `package svc
type A struct{}
func (a *A) Guessed() {}
func Make() (*A, error) { return &A{}, nil }
func UseTyped(a *A) { a.Guessed() }
func UseUntyped() {
	x, _ := Make()
	x.Guessed()
}
`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });

describe('context splits certain and guessed rows the same way callers does', () => {
  it('separates the guessed caller under its own heading instead of mixing it in unmarked', () => {
    run(['index', '--full']);

    const callersText = run(['callers', 'svc.A.Guessed']);
    const contextText = run(['context', 'svc.A.Guessed']);

    // callers already splits — this is the known-good half of the comparison.
    expect(callersText).toContain('svc.UseTyped');
    expect(callersText).toContain('UNVERIFIED: 1 more caller, matched by name only (guess)');
    expect(callersText).toContain('svc.UseUntyped');

    // context must draw the exact same line for the exact same symbol: the
    // certain caller printed plainly, the guessed one named and set apart
    // under the same heading, not mixed in with no mark at all.
    expect(contextText).toContain('callers:');
    expect(contextText).toContain('svc.UseTyped');
    expect(contextText).toContain('UNVERIFIED: 1 more caller, matched by name only (guess)');
    expect(contextText).toContain('svc.UseUntyped');
    // The certain row must come before the heading, and the guessed row after
    // it -- same order as callers, not interleaved.
    const certainAt = contextText.indexOf('svc.UseTyped');
    const headingAt = contextText.indexOf('UNVERIFIED:');
    const guessedAt = contextText.lastIndexOf('svc.UseUntyped');
    expect(certainAt).toBeGreaterThan(-1);
    expect(certainAt).toBeLessThan(headingAt);
    expect(headingAt).toBeLessThan(guessedAt);
  }, 30000);
});
