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
  dir = mkdtempSync(join(tmpdir(), 'pg-libgap-'));
  mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });

// A method name the standard library also owns turns the gap report into a wall.
// Measured on re2: `callers "re2.Prog.size"` found 12 call sites and then warned
// about 290 more, of which 204 are `size()` on a `std::vector` or an
// `absl::string_view` — receivers the source types outright, and none of which
// could ever be this method. The banner cost more than the answer was worth: the
// run took $1.43 and 307 s against grep's $0.74 and 123 s, and made 35 text
// searches against grep's 18.
//
// The rows are still reported — a call the resolver refuses must never vanish —
// but as one counted line instead of a list, because there is nothing to grep for.
describe('gap rows whose receiver the source types as a library type', () => {
  beforeEach(() => {
    write('buf.h', `#pragma once
#include <string>
#include <vector>
class Buf {
 public:
  int size() const;
};
`);
    write('buf.cc', `#include "buf.h"
int Buf::size() const { return 1; }
`);
    write('use.cc', `#include "buf.h"
int Total(Buf& b) { return b.size(); }
int Words(const std::vector<int>& v) { return v.size(); }
int Chars(const std::string& s) { return s.size(); }
`);
  });

  it('does not list them under the missing-call-sites banner', () => {
    run(['index', '--full']);
    const out = run(['callers', 'Buf.size']);
    expect(out).toContain('use.cc:2');
    expect(out).not.toContain('use.cc:3');
    expect(out).not.toContain('use.cc:4');
  }, 30000);

  it('still reports them, as a counted line naming the reason', () => {
    run(['index', '--full']);
    const out = run(['callers', 'Buf.size']);
    expect(out).toMatch(/2 call sites? whose receiver the source types as a library/);
  }, 30000);

  it('carries them in --json under their own reason', () => {
    run(['index', '--full']);
    const j = JSON.parse(run(['callers', 'Buf.size', '--json']));
    const lib = (j.gaps ?? []).filter((g) => g.reason === 'library');
    expect(lib.map((g) => `${g.file}:${g.line}`).sort()).toEqual(['use.cc:3', 'use.cc:4']);
  }, 30000);

  it('does not treat a smart pointer to a repo type as a library receiver', () => {
    write('sink.h', `#pragma once
#include <memory>
class Sink {
 public:
  void emit(int v);
};
`);
    write('sink.cc', `#include "sink.h"
void Sink::emit(int v) { (void)v; }
`);
    write('fan.cc', `#include "sink.h"
void Fan(std::shared_ptr<Sink> s) { s->emit(1); }
`);
    run(['index', '--full']);
    const j = JSON.parse(run(['callers', 'Sink.emit', '--json']));
    const lib = (j.gaps ?? []).filter((g) => g.reason === 'library');
    expect(lib.map((g) => `${g.file}:${g.line}`)).not.toContain('fan.cc:2');
  }, 30000);
});
