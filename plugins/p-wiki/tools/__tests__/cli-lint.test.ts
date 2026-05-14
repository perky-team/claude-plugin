import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pwiki.mjs');

let dir: string;
function runCli(args: string[]) {
  return spawnSync('node', [cli, ...args], { cwd: dir, encoding: 'utf-8' });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-lint-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
  writeFileSync(join(dir, 'docs', 'wiki', 'pages', 'concept', 'a.md'),
    `---\nid: a\ntype: concept\ntitle: A\ncreated: 2026-05-01\nupdated: 2026-05-01\nstatus: active\ntags: []\nsources: []\n---\n\n# A\n[gone](./missing.md)\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pwiki lint', () => {
  it('emits text by default and exits 0', () => {
    const r = runCli(['lint']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Dead links/);
    expect(r.stdout).toMatch(/Total:/);
  });

  it('emits JSON with --format=json', () => {
    const r = runCli(['lint', '--format=json']);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.errors['dead-links'].length).toBeGreaterThan(0);
    expect(json.totals.errors).toBeGreaterThan(0);
  });
});
