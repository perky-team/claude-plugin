import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pwiki.mjs');

describe('pwiki CLI entry', () => {
  it('prints version on --version', () => {
    const r = spawnSync('node', [cli, '--version'], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('3.2.3');
  });

  it('exits 1 on unknown command', () => {
    const r = spawnSync('node', [cli, 'bogus'], { encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown command/i);
  });

  it('exits 3 on internal error (unexpected exception in dispatch)', () => {
    // ENOENT during raw-file body read bubbles out of the dispatch try/catch.
    const dir = mkdtempSync(join(tmpdir(), 'pwiki-internal-'));
    mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
    const r = spawnSync(
      'node',
      [cli, 'new', 'raw-file', '--title', 'x', '--source-type', 'doc', '--ingested-from', '/nonexistent-path-xyz', '--format=json'],
      { cwd: dir, encoding: 'utf-8' },
    );
    rmSync(dir, { recursive: true, force: true });
    expect(r.status).toBe(3);
    const payload = JSON.parse(r.stdout);
    expect(payload.error.code).toBe('internal');
  });

  it('init without confluence flags exits 1 with the guard message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pwiki-init-guard-'));
    mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
    const r = spawnSync('node', [cli, 'init'], { cwd: dir, encoding: 'utf-8' });
    rmSync(dir, { recursive: true, force: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/only --confluence is supported/);
  });

  it('init --mirror-confluence passes the guard (fails on missing env, not the guard)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pwiki-init-guard2-'));
    mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
    const r = spawnSync(
      'node',
      [cli, 'init', '--mirror-confluence', '--mirror-site=https://x', '--mirror-space=ENG', '--mirror-parent=200'],
      { cwd: dir, encoding: 'utf-8', env: { ...process.env, PWIKI_CONFLUENCE_EMAIL: '', PWIKI_CONFLUENCE_TOKEN: '' } },
    );
    rmSync(dir, { recursive: true, force: true });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/only --confluence is supported/);
    expect(r.stderr).toMatch(/PWIKI_CONFLUENCE_EMAIL/);
  });
});
