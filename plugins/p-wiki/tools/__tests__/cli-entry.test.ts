import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pwiki.mjs');
const manifestVersion = JSON.parse(
  readFileSync(resolve(dirname(cli), '..', '.claude-plugin', 'plugin.json'), 'utf-8'),
).version;

describe('pwiki CLI entry', () => {
  // Read from the manifest, never a literal: this assertion used to pin '3.3.0' and so
  // locked in the drift it was supposed to catch (the plugin was already at 4.12.2).
  it('prints version on --version', () => {
    const r = spawnSync('node', [cli, '--version'], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(manifestVersion);
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
