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
  dir = mkdtempSync(join(tmpdir(), 'pg-sites-'));
  mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });

// `callers` used to answer a question nobody asked. It named the calling
// FUNCTIONS and the line each was DECLARED on; people ask where the CALLS are.
// Measured on four public repos, its output held 0 of the 32 call-site lines the
// question wanted, so every agent run followed it with a text search to fetch
// them. The graph has had those lines all along — edges.file and edges.line.
// See docs/measured-benefit.md.
describe('callers and callees name the call site', () => {
  const GO = `package svc

func target() {}

func once() {
	target()
}

func twice() {
	target()
	target()
}
`;

  it('prints the line the call is written on, not the caller definition', () => {
    write('svc/svc.go', GO);
    run(['index', '--full']);

    const text = run(['callers', 'svc.target', '--stale-ok']);
    // `once` calls on line 6; it is declared on line 5. The answer must carry 6.
    expect(text).toMatch(/svc\/svc\.go:6\b/);
    expect(text).toContain('svc.once');
  }, 30000);

  it('lists every call site of a caller that calls more than once', () => {
    write('svc/svc.go', GO);
    run(['index', '--full']);

    const line = run(['callers', 'svc.target', '--stale-ok'])
      .split('\n').find((l) => l.includes('svc.twice')) ?? '';
    // `twice` calls on lines 10 and 11. Both belong in its row.
    expect(line).toMatch(/10/);
    expect(line).toMatch(/11/);
  }, 30000);

  it('--json carries call_sites for every caller row', () => {
    write('svc/svc.go', GO);
    run(['index', '--full']);

    const json = JSON.parse(run(['callers', 'svc.target', '--stale-ok', '--json']));
    const twice = json.callers.find((c) => c.qname === 'svc.twice');
    expect(twice.call_sites).toEqual([
      { file: 'svc/svc.go', line: 10 },
      { file: 'svc/svc.go', line: 11 },
    ]);
    const once = json.callers.find((c) => c.qname === 'svc.once');
    expect(once.call_sites).toEqual([{ file: 'svc/svc.go', line: 6 }]);
  }, 30000);

  it('callees name the call site too', () => {
    write('svc/svc.go', GO);
    run(['index', '--full']);

    const json = JSON.parse(run(['callees', 'svc.twice', '--stale-ok', '--json']));
    expect(json.callees[0].call_sites).toEqual([
      { file: 'svc/svc.go', line: 10 },
      { file: 'svc/svc.go', line: 11 },
    ]);
    expect(run(['callees', 'svc.twice', '--stale-ok'])).toMatch(/svc\/svc\.go:10\b/);
  }, 30000);

  // The signature is why a caller row was up to 300 characters wide. With the
  // call sites on the row it is the least useful thing there — `pgraph node`
  // still prints it, and so does `search`.
  it('drops the signature from a caller row, and keeps it in node and search', () => {
    write('svc/svc.go', GO);
    run(['index', '--full']);

    expect(run(['callers', 'svc.target', '--stale-ok'])).not.toContain('func once()');
    expect(run(['node', 'svc.once', '--stale-ok'])).toContain('func once()');
    expect(run(['search', 'once', '--stale-ok'])).toContain('func once()');
  }, 30000);
});

// The other round trip the traces showed: `search X` and then `callers X`,
// because the rule said to ask by qualified name and the agent had to find it
// first. `callers` now says what it answered for, so one call is enough.
describe('callers says which symbol it answered for', () => {
  it('names the single target it resolved', () => {
    write('svc/svc.go', 'package svc\n\nfunc target() {}\n\nfunc once() {\n\ttarget()\n}\n');
    run(['index', '--full']);

    const text = run(['callers', 'target', '--stale-ok']);
    expect(text).toMatch(/^target: function svc\.target\b/m);
    expect(JSON.parse(run(['callers', 'target', '--stale-ok', '--json'])).targets)
      .toMatchObject([{ qname: 'svc.target' }]);
  }, 30000);

  it('warns when a bare name merges more than one symbol, and names them', () => {
    write('a/a.go', 'package a\n\nfunc Dup() {}\n\nfunc UseA() {\n\tDup()\n}\n');
    write('b/b.go', 'package b\n\nfunc Dup() {}\n\nfunc UseB() {\n\tDup()\n}\n');
    run(['index', '--full']);

    const text = run(['callers', 'Dup', '--stale-ok']);
    expect(text).toContain('2 symbols named Dup');
    expect(text).toContain('a.Dup');
    expect(text).toContain('b.Dup');
    const json = JSON.parse(run(['callers', 'Dup', '--stale-ok', '--json']));
    expect(json.targets.map((t) => t.qname).sort()).toEqual(['a.Dup', 'b.Dup']);
  }, 30000);
});
