import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-graph/tools/pgraph.mjs');
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-'));
  mkdirSync(join(dir, '.git')); mkdirSync(join(dir, '.pgraph'));
  writeFileSync(join(dir, 'a.ts'), 'function foo() { bar(); }\nfunction bar() { baz(); }\nfunction baz() {}');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });

describe('cli graph queries', () => {
  it('callers/callees/impact/trace/context/explore', () => {
    run(['index', '--full']);
    // Graph answers are objects: the rows plus the call sites the graph could
    // not attribute, so an incomplete answer can never look complete.
    expect(JSON.parse(run(['callers', 'bar', '--json'])).callers.some((r) => r.qname === 'foo')).toBe(true);
    expect(JSON.parse(run(['callees', 'foo', '--json'])).callees.some((r) => r.qname === 'bar')).toBe(true);
    expect(JSON.parse(run(['impact', 'baz', '--json'])).impact.map((r) => r.qname).sort()).toEqual(['bar', 'foo']);
    expect(JSON.parse(run(['trace', 'foo', 'baz', '--json'])).path).toEqual(['foo', 'bar', 'baz']);
    expect(JSON.parse(run(['context', 'bar', '--json'])).node.qname).toBe('bar');
    expect(JSON.parse(run(['explore', 'foo', 'baz', '--json'])).length).toBe(2);
  }, 30000);
});
