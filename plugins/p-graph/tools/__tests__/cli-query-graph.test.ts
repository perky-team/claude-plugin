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

describe('context does not double-count a gap that matches both directions', () => {
  let d;
  const w = (rel, src) => {
    const abs = join(d, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, src);
  };
  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), 'pg-ctx-'));
    mkdirSync(join(d, '.git')); mkdirSync(join(d, '.pgraph'));
    // Wrapper delegation: Counter.Write calls Write on a field of an external
    // type. The call site's bare name ("Write") matches Counter.Write's own
    // name, so gapsFor (calls INTO Counter.Write) and gapsFrom (calls OUT OF
    // it) both pick up this SAME call site.
    w('iox/iox.go', `package iox
import "bytes"
type Counter struct{ inner bytes.Buffer }
func (c *Counter) Write(p []byte) (int, error) { return c.inner.Write(p) }
`);
  });
  afterEach(() => rmSync(d, { recursive: true, force: true }));
  const r = (args) => execFileSync('node', [CLI, ...args], { cwd: d, encoding: 'utf-8' });

  it('lists the call site once in the banner and once in --json gaps', () => {
    r(['index', '--full']);
    const text = r(['context', 'iox.Counter.Write']);
    expect(text).toContain('1 call site missing from this answer');
    // The gap-listing line itself, not the node header (which also names
    // iox.go:4 as Counter.Write's own definition site).
    expect(text.match(/iox\.Counter\.Write -> Write/g)).toHaveLength(1);

    const ctxJson = JSON.parse(r(['context', 'iox.Counter.Write', '--json']));
    expect(ctxJson.gaps).toHaveLength(1);
  }, 30000);
});
