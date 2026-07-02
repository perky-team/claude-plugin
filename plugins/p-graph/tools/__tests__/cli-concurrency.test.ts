import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-graph/tools/pgraph.mjs');
let dir;
const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
const runAsync = (args) => new Promise((resolve) => {
  const p = spawn('node', [CLI, ...args], { cwd: dir });
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => resolve({ code, out, err }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('cli concurrency', () => {
  it('two parallel queries after a committed change do not corrupt the graph', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pg-'));
    git(['init', '-q']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    mkdirSync(join(dir, '.pgraph'));
    writeFileSync(join(dir, 'a.ts'), 'export function foo() { bar(); }\nexport function bar() {}');
    git(['add', '.']); git(['commit', '-qm', 'init']);
    execFileSync('node', [CLI, 'index', '--full'], { cwd: dir });

    // Commit a second caller so both processes see committed drift.
    writeFileSync(join(dir, 'a.ts'),
      'export function foo() { bar(); }\nexport function bar() {}\nexport function baz() { bar(); }');
    git(['add', '.']); git(['commit', '-qm', 'add baz']);

    const [r1, r2] = await Promise.all([
      runAsync(['callers', 'bar', '--json']),
      runAsync(['callers', 'bar', '--json']),
    ]);
    for (const r of [r1, r2]) {
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out).map((x) => x.name).sort()).toEqual(['baz', 'foo']);
    }

    // Graph is intact and readable afterwards.
    const st = JSON.parse(execFileSync('node', [CLI, 'status', '--json'], { cwd: dir, encoding: 'utf-8' }));
    expect(st.nodes).toBeGreaterThanOrEqual(3);
  }, 45000);
});
