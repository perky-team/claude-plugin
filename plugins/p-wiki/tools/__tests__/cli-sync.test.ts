import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CLI = require.resolve('../pwiki.mjs');

function run(cwd: string, args: string[]) {
  return spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf-8' });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-cli-sync-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), 'placeholder', 'utf-8');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pwiki sync CLI', () => {
  it('exits 0 with ok:true when .pwiki.json has no mirrors (default FS-only)', () => {
    // Default FS-only config has mirrors: []; sync is a no-op + indexed=true.
    const r = run(dir, ['sync', '--format=json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.mirrors).toEqual([]);
  });

  it('exits 2 with config-invalid when primary references an unknown destination', () => {
    writeFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), JSON.stringify({
      primary: 'ghost', mirrors: [], destinations: { fs: { kind: 'fs' } },
    }), 'utf-8');
    const r = run(dir, ['sync', '--format=json']);
    expect(r.status).toBe(2);
    const out = JSON.parse(r.stdout);
    expect(out.error.code).toBe('config-invalid');
  });
});
