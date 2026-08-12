import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-graph/tools/pgraph.mjs');
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-dupq-'));
  mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};

// A TypeScript qname carries no module path, so a monorepo with several sample
// apps has the same qname several times over. The hint then told the reader to
// "ask by qname to separate" and printed one name three times — advice that cannot
// be followed. Measured on nest: 393 duplicated qnames, and
// `callers "RecipesService.findOneById"` printed the same string three times.
describe('several symbols under one qname', () => {
  it('names them by file and line, not by a qname they share', () => {
    write('a/svc.ts', `export class Svc {\n  find(id: number): number { return id; }\n}\n`);
    write('b/svc.ts', `export class Svc {\n  find(id: number): number { return id; }\n}\n`);
    run(['index', '--full']);

    const out = run(['callers', 'Svc.find']);
    expect(out).toContain('2 symbols named find');
    expect(out).toContain('a/svc.ts:2');
    expect(out).toContain('b/svc.ts:2');
    expect(out).not.toContain('Ask by qname to separate');
  }, 30000);

  // When the qnames really are different, the old advice is the useful one: the
  // reader can type one of them and get a narrower answer.
  it('still offers the qnames when they differ', () => {
    write('a.ts', `export class One {\n  find(id: number): number { return id; }\n}\nexport class Two {\n  find(id: number): number { return id; }\n}\n`);
    run(['index', '--full']);

    const out = run(['callers', 'find']);
    expect(out).toContain('Ask by qname to separate: One.find, Two.find');
  }, 30000);
});
