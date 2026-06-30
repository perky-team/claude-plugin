// Packaging guard for p-tasks (regression: 1.1.0 shipped with no js-yaml, so the
// CLI died with ERR_MODULE_NOT_FOUND once copied into the plugin cache).
//
// Plugins are distributed by copying files into a cache with NO install step, so
// the shipped tools must be self-sufficient at rest. These tests fail if a tool
// reintroduces a bare runtime dependency or if the vendored copy goes missing.
//
// Runs under `npm test` (vitest) — i.e. the suite the /release skill audits in
// Step 2 — so a future release that drops the dependency is blocked before tag.

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { repoRoot } from './helpers';

// Spawns several cold `node` processes; give the same headroom as the in-tree e2e.
vi.setConfig({ testTimeout: 30_000 });

const PTASKS_DIR = join(repoRoot(), 'plugins', 'p-tasks');
const VENDORED_YAML = join(PTASKS_DIR, 'tools', 'lib', 'vendor', 'js-yaml.mjs');

// Recursively collect *.mjs under a tools/ dir, skipping tests and vendored code
// (vendored bundles are third-party and allowed to contain whatever they ship).
function toolSources(toolsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'vendor') continue;
        walk(join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith('.mjs')) {
        out.push(join(dir, e.name));
      }
    }
  };
  walk(toolsDir);
  return out;
}

// Drop comments so import-like phrases in prose (e.g. "not a bare import 'x'")
// aren't mistaken for real imports. Truncating a URL inside a string is harmless
// here — it can't manufacture a false import specifier.
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// Pull the module specifier out of every static/dynamic import & re-export form.
function importedSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const specs: string[] = [];
  const patterns = [
    /\bimport\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g, // import x from 'spec'
    /\bexport\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g, // export ... from 'spec'
    /\bimport\s*['"]([^'"]+)['"]/g,                 // import 'spec' (side-effect)
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,        // import('spec') (dynamic)
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

const isBare = (spec: string) =>
  !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:');

describe('p-tasks packaging — self-contained at rest', () => {
  it('no tool source imports a bare runtime dependency', () => {
    const offenders: string[] = [];
    for (const file of toolSources(join(PTASKS_DIR, 'tools'))) {
      for (const spec of importedSpecifiers(readFileSync(file, 'utf-8'))) {
        if (isBare(spec)) {
          offenders.push(`${relative(repoRoot(), file)} -> '${spec}'`);
        }
      }
    }
    // A bare specifier resolves only via a node_modules tree that ships with the
    // plugin — which it doesn't. Vendor it under tools/lib/vendor/ and import it
    // by relative path instead (see scripts/vendor-deps.mjs).
    expect(offenders).toEqual([]);
  });

  it('ships the vendored js-yaml build and imports it relatively', () => {
    expect(statSync(VENDORED_YAML).size).toBeGreaterThan(10_000);
    const yamlMjs = readFileSync(join(PTASKS_DIR, 'tools', 'lib', 'yaml.mjs'), 'utf-8');
    expect(yamlMjs).toMatch(/from\s+['"]\.\/vendor\/js-yaml\.mjs['"]/);
  });
});

// The static guard above can be fooled (a dependency hidden behind something the
// regexes miss). The real proof is running the CLI from a copy that has NO
// node_modules anywhere above it — exactly how the plugin lands in the cache.
describe('p-tasks packaging — CLI runs from an isolated copy', () => {
  let pkgRoot: string; // isolated copy of plugins/p-tasks (no node_modules above it)
  let cli: string;
  let dataDir: string; // throwaway "repo" the CLI writes into

  beforeAll(() => {
    // tmpdir() has no node_modules in its parent chain, so a bare import here
    // would fail to resolve — reproducing the shipped-artifact failure mode.
    pkgRoot = mkdtempSync(join(tmpdir(), 'ptasks-pkg-'));
    cpSync(PTASKS_DIR, pkgRoot, { recursive: true });
    rmSync(join(pkgRoot, 'tools', '__tests__'), { recursive: true, force: true });
    cli = join(pkgRoot, 'tools', 'ptasks.mjs');
    dataDir = mkdtempSync(join(tmpdir(), 'ptasks-data-'));
  });
  afterAll(() => {
    rmSync(pkgRoot, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  // Sanity: the copy must not have dragged a node_modules along, or the test
  // would pass for the wrong reason.
  it('the isolated copy has no node_modules of its own', () => {
    expect(() => statSync(join(pkgRoot, 'node_modules'))).toThrow();
  });

  function run(args: string[], cwd: string) {
    const res = spawnSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pkgRoot },
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  it('runs the full VERIFY flow with valid JSON and no ERR_MODULE_NOT_FOUND', () => {
    let r = run(['--version'], dataDir);
    expect(r.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);

    r = run(['init', '--primary', 'fs', '--json'], dataDir);
    expect(r.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, primary: 'fs' });

    r = run(['add', 'task', '--title', 't', '--json'], dataDir);
    expect(r.status).toBe(0);
    const task = JSON.parse(r.stdout);
    expect(task).toMatchObject({ id: 't-1', type: 'task', title: 't' });

    r = run(
      ['add', 'sub-task', 't-1', '--title', 's', '--acceptance', 'x',
       '--files', 'a.go,b.go', '--kind', 'code', '--origin', 'plan', '--json'],
      dataDir,
    );
    expect(r.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      type: 'sub-task', parentId: 't-1', title: 's',
      acceptance: 'x', files: ['a.go', 'b.go'], kind: 'code', origin: 'plan',
    });

    r = run(['list', 't-1', '--json'], dataDir);
    expect(r.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(r.status).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});
