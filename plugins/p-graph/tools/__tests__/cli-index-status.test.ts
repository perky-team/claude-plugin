import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';

const CLI = join(process.cwd(), 'plugins/p-graph/tools/pgraph.mjs');
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-'));
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, '.pgraph'));
  writeFileSync(join(dir, 'a.ts'), 'function foo() { bar(); }\nfunction bar() {}');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf-8' });

describe('cli index/status', () => {
  it('index --full then status --json reports counts', () => {
    run(['index', '--full']);
    const st = JSON.parse(run(['status', '--json']));
    expect(st.nodes).toBeGreaterThanOrEqual(2);
    expect(st.files).toBe(1);
  }, 30000);

  it('says a rebuild is pending after a schema upgrade, instead of just showing an empty graph', () => {
    run(['index', '--full']);
    // Simulate a plugin upgrade: openStore already dropped the tables by the
    // time status reads them, since status never calls ensureFresh.
    const store = openStore(join(dir, '.pgraph', 'graph.db'));
    store.setMeta('schema_version', '1');
    store.close();
    const text = run(['status']);
    expect(text).toContain('0 nodes');
    expect(text).toContain('rebuild pending');
  }, 30000);
});
