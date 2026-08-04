import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';

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
    expect(JSON.parse(run(['callers', 'bar', '--json']).stdout).callers.map((r) => r.name)).toEqual(['foo']);

    // add a second caller, do NOT sync
    writeFileSync(join(dir, 'a.ts'),
      'export function foo() { bar(); }\nexport function bar() {}\nexport function baz() { bar(); }');
    const r = run(['callers', 'bar', '--json']);
    const names = JSON.parse(r.stdout).callers.map((x) => x.name).sort();
    expect(names).toEqual(['baz', 'foo']);           // auto-refreshed
    expect(r.stderr).toContain('p-graph: refreshing');
  }, 30000);

  it('drift 0 is the fast path — no refresh note', () => {
    initRepo();
    run(['index', '--full']);
    const r = run(['callers', 'bar', '--json']);
    expect(r.stderr).not.toContain('refreshing');
    expect(JSON.parse(r.stdout).callers.map((x) => x.name)).toEqual(['foo']);
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
    expect(JSON.parse(r.stdout).callers.map((x) => x.name)).toEqual(['foo']); // NOT refreshed
    expect(r.stderr).toContain('⚠ p-graph STALE: 1 files changed since index');
  }, 30000);

  it('PGRAPH_AUTOREFRESH=0 skips refresh and prints the banner', () => {
    initRepo();
    run(['index', '--full']);
    writeFileSync(join(dir, 'a.ts'),
      'export function foo() { bar(); }\nexport function bar() {}\nexport function baz() { bar(); }');
    const r = run(['callers', 'bar', '--json'], { PGRAPH_AUTOREFRESH: '0' });
    expect(JSON.parse(r.stdout).callers.map((x) => x.name)).toEqual(['foo']);
    expect(r.stderr).toContain('⚠ p-graph STALE:');
  }, 30000);

  it('non-git repo: query still answers, with the unknown-drift banner', () => {
    dir = mkdtempSync(join(tmpdir(), 'pg-'));
    mkdirSync(join(dir, '.git'));    // empty dir: findRepoRoot stops here, git commands fail
    mkdirSync(join(dir, '.pgraph'));
    writeFileSync(join(dir, 'a.ts'), 'export function foo() { bar(); }\nexport function bar() {}');
    run(['index', '--full']);
    const r = run(['callers', 'bar', '--json']);
    expect(JSON.parse(r.stdout).callers.map((x) => x.name)).toEqual(['foo']); // still answers
    expect(r.stderr).toContain('cannot verify freshness');
  }, 30000);

  it('rebuilds when the stored schema is older than the code, even at zero drift', () => {
    initRepo();
    run(['index', '--full']);
    // Simulate a plugin upgrade: mark the on-disk graph as an older schema.
    const store = openStore(join(dir, '.pgraph', 'graph.db'));
    store.setMeta('schema_version', '1');
    store.close();
    const r = run(['callers', 'bar', '--json']);
    expect(r.stderr).toContain('rebuilding graph after schema upgrade');
    expect(JSON.parse(r.stdout).callers.map((x) => x.name)).toEqual(['foo']); // answers off the rebuilt graph
    // schema is now current, so a second query is the fast path (no rebuild).
    expect(run(['callers', 'bar', '--json']).stderr).not.toContain('rebuilding');
  }, 30000);

  it('rebuilds on schema upgrade even when git cannot report drift (non-git tree)', () => {
    dir = mkdtempSync(join(tmpdir(), 'pg-'));
    mkdirSync(join(dir, '.git'));    // empty dir: findRepoRoot stops here, git commands fail
    mkdirSync(join(dir, '.pgraph'));
    writeFileSync(join(dir, 'a.ts'), 'export function foo() { bar(); }\nexport function bar() {}');
    run(['index', '--full']);
    // Simulate a plugin upgrade on a tree where git status can never be read.
    const store = openStore(join(dir, '.pgraph', 'graph.db'));
    store.setMeta('schema_version', '1');
    store.close();
    const r = run(['callers', 'bar', '--json']);
    // The schema upgrade must force a rebuild even though drift is unknown —
    // otherwise openStore already dropped the tables and the answer is empty.
    expect(JSON.parse(r.stdout).callers.map((x) => x.name)).toEqual(['foo']);
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

  // `status` used to count every changed path git reports, including files
  // the index never reads at all (a doc edit) and .pgraph/ itself — which is
  // untracked right after `index --full` creates it. Every corpus in the
  // evaluation read "drift 1" straight after a full index for exactly this
  // reason. `computeActionable` (freshness.mjs) already filters to the files
  // a refresh would actually reparse; `status` must count the same way.
  it('does not count a non-source edit or an untracked file as drift', () => {
    initRepo();
    run(['index', '--full']); // creates .pgraph/, still untracked at this point
    writeFileSync(join(dir, 'README.md'), '# hello');
    writeFileSync(join(dir, 'notes.txt'), 'not source');
    const st = JSON.parse(run(['status', '--json']).stdout);
    expect(st.drift).toBe(0);
  }, 30000);

  // Every git call in build.mjs runs even in a non-git tree, and git's own
  // "fatal: not a git repository" line used to leak straight through — not
  // just into this test's output, but onto the plugin's own stderr on every
  // real invocation. p-graph's own STALE banner already tells the user what
  // matters; git's raw complaint underneath it is noise.
  it('never leaks git\'s own "fatal:" line in a non-git tree', () => {
    dir = mkdtempSync(join(tmpdir(), 'pg-'));
    mkdirSync(join(dir, '.git'));    // empty dir: findRepoRoot stops here, git commands fail
    mkdirSync(join(dir, '.pgraph'));
    writeFileSync(join(dir, 'a.ts'), 'export function foo() { bar(); }\nexport function bar() {}');

    const idx = run(['index', '--full']);
    expect(idx.stderr).not.toContain('fatal:');

    const st = run(['status']);
    expect(st.stderr).not.toContain('fatal:');
  }, 30000);
});
