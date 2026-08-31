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
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-target-'));
  mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Every command must find its target the way `callers` finds it: by id, by qname
// OR by bare name. `impact` and `callees` looked the target up with `store.node`,
// which matches an id or a qname and never a bare name — so `impact Root` and
// `callees Do` answered about NOTHING for every Go function and for every method
// in any language, and then said `✓ complete`. The rule this plugin ships tells
// the agent to ask by bare name ("Ask by bare name — one call, not two"), so that
// is the documented path.
describe('every command answers a bare name, the same as callers does', () => {
  beforeEach(() => {
    write('go.mod', 'module x\n\ngo 1.21\n');
    write('svc/svc.go', `package svc

func Root() int { return 1 }
`);
    // Two call sites: one inside a func, one at package scope (no enclosing
    // symbol, so it is a `file` row).
    write('app/app.go', `package app

import "x/svc"

var _ = func() int { return svc.Root() }()

func Mid() int { return svc.Root() }
`);
    run(['index', '--full']);
  });

  it('lists for a bare name what it lists for the qname', () => {
    const bare = run(['impact', 'Root']);
    expect(bare).not.toContain('(no impact)');
    expect(bare).toContain('function app.Mid');
    expect(bare).toMatch(/file app\/app\.go\s+5/);

    // Same question, spelled two ways, so the answers must be the same rows.
    const byBare = JSON.parse(run(['impact', 'Root', '--json'])).impact;
    const byQname = JSON.parse(run(['impact', 'svc.Root', '--json'])).impact;
    expect(byBare.map((r) => r.qname).sort()).toEqual(byQname.map((r) => r.qname).sort());
  }, 30000);

  // One array, one row shape. A file row carries `guess` and `call_sites`; a node
  // row carried neither, so a consumer reading
  // `json.impact.map((r) => r.call_sites.length)` threw on the node rows. Both
  // keys are additive, and both are true of a node row: the walk follows certain
  // edges only, and it names symbols, not call sites.
  it('gives every impact row the same shape in --json', () => {
    const rows = JSON.parse(run(['impact', 'Root', '--json'])).impact;
    expect(rows.map((r) => r.kind)).toEqual(['function', 'file']);
    for (const r of rows) {
      expect(Array.isArray(r.call_sites)).toBe(true);
      expect(r.guess).toBe(0);
    }
  }, 30000);

  // `callers Root` on this fixture lists both call sites and says `✓ complete`.
  // `impact Root` printed `(no impact)` and said `✓ complete` too — the same
  // strongest-claim line over an empty answer. One symbol, two commands, two
  // different facts.
  it('agrees with callers about the same symbol', () => {
    const callers = run(['callers', 'Root']);
    const impact = run(['impact', 'Root']);
    for (const text of [callers, impact]) {
      expect(text).toContain('app.Mid');
      expect(text).toMatch(/file app\/app\.go\s+5/);
      expect(text).toContain('✓ complete');
    }
  }, 30000);

  // `store.trace` resolved BOTH endpoints with store.node, so `trace Mid Root`
  // printed `(no path)` while `trace app.Mid svc.Root` printed the path. Nothing
  // rescued it: no banner, and exit 0. The skill tells the agent that `(no path)`
  // means the graph found nothing along resolved calls, so the agent reports "there
  // is no path" as a fact about the code.
  it('traces between two bare names', () => {
    const bare = run(['trace', 'Mid', 'Root']);
    expect(bare).not.toContain('(no path)');
    expect(bare).toContain('app.Mid -> svc.Root');

    const byBare = JSON.parse(run(['trace', 'Mid', 'Root', '--json']));
    const byQname = JSON.parse(run(['trace', 'app.Mid', 'svc.Root', '--json']));
    expect(byBare.path).toEqual(['app.Mid', 'svc.Root']);
    expect(byBare.path).toEqual(byQname.path);
    expect(byBare.guessed_hops).toEqual([false]);
  }, 30000);

  // "no path between these two" and "I never found one of these two" are different
  // answers, and `(no path)` said the first when the second was true.
  it('says an endpoint is unknown instead of printing (no path)', () => {
    const text = run(['trace', 'Mid', 'Nope']);
    expect(text).toContain('no symbol named Nope in the graph');
    expect(text).not.toContain('(no path');

    const json = JSON.parse(run(['trace', 'Mid', 'Nope', '--json']));
    expect(json.path).toBeNull();
    expect(json.unknown_symbols).toEqual(['Nope']);
  }, 30000);

  // `explore` mapped store.node over its arguments and dropped every miss, so
  // `explore Root` printed nothing at all and exited 0 — and the rule lists
  // `pgraph explore A B C` as the way to ask about several symbols at once.
  it('explores a bare name', () => {
    expect(run(['explore', 'Root'])).toContain('function svc.Root');
    const rows = JSON.parse(run(['explore', 'Root', 'Mid', '--json']));
    expect(rows.map((r) => r.qname).sort()).toEqual(['app.Mid', 'svc.Root']);
  }, 30000);

  it('says so when an explored name is in nothing', () => {
    expect(run(['explore', 'Nope'])).toContain('no symbol named Nope in the graph');
  }, 30000);

  // `context` exited 1 for every Go function and every method, because its header
  // row still came from store.node while its lists already matched a bare name.
  it('gives a bare name the context the qname gives', () => {
    const byBare = run(['context', 'Root']);
    const byQname = run(['context', 'svc.Root']);
    for (const text of [byBare, byQname]) {
      expect(text).toContain('function svc.Root');
      expect(text).toContain('function app.Mid');
      expect(text).toMatch(/file app\/app\.go\s+5/);
    }
    expect(JSON.parse(run(['context', 'Root', '--json'])).node.qname).toBe('svc.Root');
  }, 30000);
});

describe('a bare name shared by two symbols is answered for both', () => {
  beforeEach(() => {
    write('go.mod', 'module x\n\ngo 1.21\n');
    write('pkga/pkga.go', 'package pkga\n\nfunc Run() {}\n');
    write('pkgb/pkgb.go', 'package pkgb\n\nfunc Run() {}\n');
    // One function calls both, so a union that forgets to dedupe prints it twice.
    write('both/both.go', `package both

import (
	"x/pkga"
	"x/pkgb"
)

func Both() {
	pkga.Run()
	pkgb.Run()
}
`);
    // One FILE holds a package-scope call to each, so the two file rows must be
    // merged into one row carrying both lines. Merging per-target rows by file id
    // and keeping the first would drop line 9 — a real call site lost under
    // `✓ complete`.
    write('boot/boot.go', `package boot

import (
	"x/pkga"
	"x/pkgb"
)

var _ = func() { pkga.Run() }()
var _ = func() { pkgb.Run() }()
`);
    run(['index', '--full']);
  });

  // `callers Run` prints "2 symbols named Run — the rows below merge all of them",
  // `impact Run` printed pkga.Run's blast radius with nothing said. So "what breaks
  // if I change Run" attributed one package's callers to the other one's function.
  // The rule promises the first line of the answer names the symbol it resolved.
  it('says which symbols it merged, the same as callers does', () => {
    for (const cmd of ['callers', 'impact', 'context']) {
      const text = run([cmd, 'Run']);
      expect(text).toContain('2 symbols named Run — the rows below merge all of them.');
      expect(text).toContain('Ask by qname to separate: pkga.Run, pkgb.Run');
    }
  }, 30000);

  it('explores every symbol a shared name carries', () => {
    const rows = JSON.parse(run(['explore', 'Run', '--json']));
    expect(rows.map((r) => r.qname)).toEqual(['pkga.Run', 'pkgb.Run']);
  }, 30000);

  it('unions the two impacts and names each row once', () => {
    const json = JSON.parse(run(['impact', 'Run', '--json']));
    const nodeRows = json.impact.filter((r) => r.kind !== 'file');
    expect(nodeRows.map((r) => r.qname)).toEqual(['both.Both']);
  }, 30000);

  it('keeps every line of one file on one row', () => {
    const json = JSON.parse(run(['impact', 'Run', '--json']));
    const fileRows = json.impact.filter((r) => r.kind === 'file');
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0].qname).toBe('boot/boot.go');
    expect(fileRows[0].call_sites.map((s) => s.line)).toEqual([8, 9]);

    const text = run(['impact', 'Run']);
    expect(text).toMatch(/file boot\/boot\.go\s+8, 9/);
  }, 30000);
});

// The count of refused guesses has to resolve the target the same way the walk
// does, or the two describe different symbols. It used `store.node` as well, so
// for a bare name the safety net was off: an empty list, nothing counted, and
// `✓ complete` over a real call site the graph could not settle.
describe('a refused guess is counted for a bare-name target too', () => {
  beforeEach(() => {
    // `x` is typed from a function's return value, a shape the graph does not
    // track, so the only path in is the unique-bare-name guess. `impact` refuses
    // to walk a guess, so the list stays empty — and the count is the only thing
    // that says why.
    write('go.mod', 'module x\n\ngo 1.21\n');
    write('svc/svc.go', `package svc

type A struct{}

func (a *A) Guessed() {}

func Make() (*A, error) { return &A{}, nil }

func R1() { x, _ := Make(); x.Guessed() }
`);
    run(['index', '--full']);
  });

  it('counts it and refuses the completeness line', () => {
    const json = JSON.parse(run(['impact', 'Guessed', '--json']));
    expect(json.skipped_guesses).toBe(1);
    expect(json.complete).toBe(false);

    const text = run(['impact', 'Guessed']);
    expect(text).toContain('1 guessed edge');
    expect(text).not.toContain('✓ complete');
  }, 30000);
});

// Same root cause on `callees`: `store.gapsFrom` looked the caller up with
// `store.node`, so a bare name got no gap report at all. Measured on this
// fixture: `callees T.do` says `⚠ 1 call site missing`, `callees do` said
// `✓ complete`.
describe('callees answers a bare name', () => {
  beforeEach(() => {
    write('lib/a.js', 'export class A {\n  hit() { return 1; }\n}\n');
    write('lib/b.js', 'export class B {\n  hit() { return 2; }\n}\n');
    // `x` is a plain parameter, so the receiver's type is unknown and two repo
    // methods carry the name — the resolver refuses, and the call is a gap.
    write('lib/t.js', 'export class T {\n  do(x) { return x.hit(); }\n}\n');
    run(['index', '--full']);
  });

  it('reports the same gap for the bare name as for the qname', () => {
    const byQname = run(['callees', 'T.do']);
    expect(byQname).toContain('1 call site missing from this answer');

    const byBare = run(['callees', 'do']);
    expect(byBare).toContain('1 call site missing from this answer');
    expect(byBare).toContain('lib/t.js:2');
    expect(byBare).not.toContain('✓ complete');

    const json = JSON.parse(run(['callees', 'do', '--json']));
    expect(json.complete).toBe(false);
    expect(json.gaps.map((g) => g.dst_name)).toEqual(['hit']);
  }, 30000);
});

// A node id is the third spelling of a target, and `callers`/`callees` matched a
// name or a qname only — so an id argument printed an EMPTY list. The gap rows
// used to make that visibly short; once file-scope calls became list rows, the
// same answer ended in `✓ complete` over nothing.
describe('an answer asked for by node id', () => {
  let id;
  beforeEach(() => {
    write('lib/manager.js', 'export class Manager {\n  eject(id) { return id; }\n}\n');
    write('app/boot.js', `import { Manager } from '../lib/manager.js';
const m = new Manager();
m.eject(1);
`);
    write('app/run.js', `import { Manager } from '../lib/manager.js';
export function run() { const m = new Manager(); return m.eject(3); }
`);
    run(['index', '--full']);
    id = JSON.parse(run(['node', 'Manager.eject', '--json'])).id;
  });

  it('lists the rows the qname lists, in context', () => {
    const byId = run(['context', id]);
    expect(byId).toContain('function run');
    expect(byId).toMatch(/file app\/boot\.js\s+3/);

    // The rows a reader gets must not depend on which spelling was typed.
    const byQname = run(['context', 'Manager.eject']);
    for (const text of [byId, byQname]) {
      expect(text).toContain('function run');
      expect(text).toMatch(/file app\/boot\.js\s+3/);
    }
  }, 30000);

  it('is not reported as an unknown name by callers', () => {
    const text = run(['callers', id]);
    expect(text).not.toContain('no symbol named');
    expect(text).toContain('function run');
    expect(text).toMatch(/file app\/boot\.js\s+3/);
  }, 30000);
});
