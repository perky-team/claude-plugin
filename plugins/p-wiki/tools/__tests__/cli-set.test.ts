import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pwiki.mjs');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-set-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
  writeFileSync(join(dir, 'docs', 'wiki', 'pages', 'concept', 'foo.md'),
    `---\nid: foo\ntype: concept\ntitle: Foo\ncreated: 2026-05-01\nupdated: 2026-05-01\nstatus: active\ntags: [a]\nsources: []\n---\n\n# Foo\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runCli(args: string[]) {
  return spawnSync('node', [cli, ...args], { cwd: dir, encoding: 'utf-8' });
}

describe('pwiki set', () => {
  it('bumps updated and reports changed fields', () => {
    const r = runCli(['set', 'docs/wiki/pages/concept/foo.md', '--bump-updated', '--add-source=raw/x.md', '--format=json']);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.changed).toEqual(expect.arrayContaining(['updated', 'sources']));
    expect(json.noop).toBe(false);
  });

  it('reports noop when nothing changed', () => {
    runCli(['set', 'docs/wiki/pages/concept/foo.md', '--add-source=raw/x.md', '--format=json']);
    const r = runCli(['set', 'docs/wiki/pages/concept/foo.md', '--add-source=raw/x.md', '--format=json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).noop).toBe(true);
  });

  it('exits 1 when file missing', () => {
    const r = runCli(['set', 'docs/wiki/pages/concept/missing.md', '--bump-updated', '--format=json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not found/i);
  });
});
