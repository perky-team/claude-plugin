import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
});
