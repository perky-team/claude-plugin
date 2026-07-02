import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'plugins/p-graph/tools/pgraph.mjs');

let dir;
const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
const run = (args, env) =>
  spawnSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8', env: { ...process.env, ...env } });

function initRepo() {
  dir = mkdtempSync(join(tmpdir(), 'pg-'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  mkdirSync(join(dir, '.pgraph'));
  writeFileSync(join(dir, 'a.ts'), 'export function foo() { bar(); }\nexport function bar() {}');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
}
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('cli auto-refresh', () => {
  it('reflects an uncommitted change without a manual sync', () => {
    initRepo();
    run(['index', '--full']);
    // baseline: only foo calls bar
    expect(JSON.parse(run(['callers', 'bar', '--json']).stdout).map((r) => r.name)).toEqual(['foo']);

    // add a second caller, do NOT sync
    writeFileSync(join(dir, 'a.ts'),
      'export function foo() { bar(); }\nexport function bar() {}\nexport function baz() { bar(); }');
    const r = run(['callers', 'bar', '--json']);
    const names = JSON.parse(r.stdout).map((x) => x.name).sort();
    expect(names).toEqual(['baz', 'foo']);           // auto-refreshed
    expect(r.stderr).toContain('p-graph: refreshing');
  }, 30000);

  it('drift 0 is the fast path — no refresh note', () => {
    initRepo();
    run(['index', '--full']);
    const r = run(['callers', 'bar', '--json']);
    expect(r.stderr).not.toContain('refreshing');
    expect(JSON.parse(r.stdout).map((x) => x.name)).toEqual(['foo']);
  }, 30000);

  it('a non-source edit does not trigger a refresh', () => {
    initRepo();
    run(['index', '--full']);
    writeFileSync(join(dir, 'README.md'), '# hello');
    const r = run(['callers', 'bar', '--json']);
    expect(r.stderr).not.toContain('refreshing');
    expect(r.stderr).not.toContain('STALE');
  }, 30000);

  it('--stale-ok skips refresh and prints the banner when drifted', () => {
    initRepo();
    run(['index', '--full']);
    writeFileSync(join(dir, 'a.ts'),
      'export function foo() { bar(); }\nexport function bar() {}\nexport function baz() { bar(); }');
    const r = run(['callers', 'bar', '--json', '--stale-ok']);
    expect(JSON.parse(r.stdout).map((x) => x.name)).toEqual(['foo']); // NOT refreshed
    expect(r.stderr).toContain('⚠ p-graph STALE: 1 files changed since index');
  }, 30000);

  it('PGRAPH_AUTOREFRESH=0 skips refresh and prints the banner', () => {
    initRepo();
    run(['index', '--full']);
    writeFileSync(join(dir, 'a.ts'),
      'export function foo() { bar(); }\nexport function bar() {}\nexport function baz() { bar(); }');
    const r = run(['callers', 'bar', '--json'], { PGRAPH_AUTOREFRESH: '0' });
    expect(JSON.parse(r.stdout).map((x) => x.name)).toEqual(['foo']);
    expect(r.stderr).toContain('⚠ p-graph STALE:');
  }, 30000);

  it('non-git repo: query still answers, with the unknown-drift banner', () => {
    dir = mkdtempSync(join(tmpdir(), 'pg-'));
    mkdirSync(join(dir, '.git'));    // empty dir: findRepoRoot stops here, git commands fail
    mkdirSync(join(dir, '.pgraph'));
    writeFileSync(join(dir, 'a.ts'), 'export function foo() { bar(); }\nexport function bar() {}');
    run(['index', '--full']);
    const r = run(['callers', 'bar', '--json']);
    expect(JSON.parse(r.stdout).map((x) => x.name)).toEqual(['foo']); // still answers
    expect(r.stderr).toContain('cannot verify freshness');
  }, 30000);

  it('status does not reindex', () => {
    initRepo();
    run(['index', '--full']);
    const before = JSON.parse(run(['status', '--json']).stdout);
    const r = run(['status', '--json']);
    const after = JSON.parse(r.stdout);
    expect(after.nodes).toBe(before.nodes);
    expect(after.indexed_sha).toBe(before.indexed_sha);
    expect(r.stderr).not.toContain('refreshing');
  }, 30000);
});
