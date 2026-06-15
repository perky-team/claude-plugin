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
  writeFileSync(join(dir, 'a.ts'), 'function foo() { bar(); }\nfunction bar() {}');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });

describe('cli search/node/files', () => {
  it('search and node and files', () => {
    run(['index', '--full']);
    expect(JSON.parse(run(['search', 'foo', '--json'])).some((r) => r.qname === 'foo')).toBe(true);
    expect(JSON.parse(run(['node', 'foo', '--json'])).kind).toBe('function');
    expect(JSON.parse(run(['files', 'a.ts', '--json']))[0].symbols).toBeGreaterThanOrEqual(2);
  }, 30000);
});
