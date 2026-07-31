import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pwiki.mjs');

function run(cwd: string, ...argv: string[]) {
  const r = spawnSync('node', [cli, ...argv], { cwd, encoding: 'utf-8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function readCfg(root: string) {
  return JSON.parse(readFileSync(join(root, 'docs', 'wiki', '.pwiki.json'), 'utf-8'));
}

/** A minimal FS wiki: docs/wiki/CLAUDE.md marks the root, pages/concept holds one page. */
function makeWiki(prefix: string, opts: { config?: unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
  writeFileSync(join(dir, 'docs', 'wiki', 'pages', 'concept', 'home.md'),
    '---\nid: home\ntype: concept\ntitle: Home\n---\n\n# Home\n\nbody\n');
  if (opts.config !== undefined) {
    writeFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), JSON.stringify(opts.config), 'utf-8');
  }
  return dir;
}

describe('pwiki source add', () => {
  let primary: string;
  let other: string;
  beforeEach(() => {
    primary = makeWiki('pwiki-srcadd-primary-', { config: { primary: 'fs', mirrors: [], destinations: { fs: { kind: 'fs' } } } });
    other = makeWiki('pwiki-srcadd-other-');
  });
  afterEach(() => {
    rmSync(primary, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it('adds an fs source and records it under sources + destinations', () => {
    const r = run(primary, 'source', 'add', 'specs', '--kind=fs', `--path=${other}`);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.out);
    expect(json.ok).toBe(true);
    expect(json.verified).toBe(true);
    const cfg = readCfg(primary);
    expect(cfg.sources).toEqual(['specs']);
    expect(cfg.destinations.specs).toEqual({ kind: 'fs', path: other });
    expect(cfg.primary).toBe('fs');
  });

  it('the added source is immediately readable via get --source', () => {
    expect(run(primary, 'source', 'add', 'specs', '--kind=fs', `--path=${other}`).status).toBe(0);
    const r = run(primary, 'get', 'docs/wiki/pages/concept/home.md', '--source=specs', '--format=json');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out).body).toContain('body');
  });

  it('works when .pwiki.json does not exist yet (default fs wiki)', () => {
    const bare = makeWiki('pwiki-srcadd-bare-');
    try {
      expect(existsSync(join(bare, 'docs', 'wiki', '.pwiki.json'))).toBe(false);
      const r = run(bare, 'source', 'add', 'specs', '--kind=fs', `--path=${other}`);
      expect(r.status).toBe(0);
      const cfg = readCfg(bare);
      expect(cfg.primary).toBe('fs');
      expect(cfg.destinations.fs).toEqual({ kind: 'fs' });
      expect(cfg.sources).toEqual(['specs']);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('appends to an existing source list instead of replacing it', () => {
    const second = makeWiki('pwiki-srcadd-second-');
    try {
      run(primary, 'source', 'add', 'specs', '--kind=fs', `--path=${other}`);
      const r = run(primary, 'source', 'add', 'platform', '--kind=fs', `--path=${second}`);
      expect(r.status).toBe(0);
      expect(readCfg(primary).sources).toEqual(['specs', 'platform']);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('adds a github source with --no-verify (no network in tests)', () => {
    const r = run(primary, 'source', 'add', 'specs', '--kind=github', '--owner=my-org', '--repo=repo-specs', '--no-verify');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out).verified).toBe(false);
    expect(readCfg(primary).destinations.specs).toEqual({ kind: 'github', owner: 'my-org', repo: 'repo-specs' });
  });

  it('carries optional bundle fields onto a gitlab source', () => {
    const r = run(primary, 'source', 'add', 'specs', '--kind=gitlab', '--project=group/specs',
      '--base-url=https://gitlab.example.com', '--ref=release', '--index-path=wiki/index.json', '--no-verify');
    expect(r.status).toBe(0);
    expect(readCfg(primary).destinations.specs).toEqual({
      kind: 'gitlab', project: 'group/specs', baseUrl: 'https://gitlab.example.com',
      ref: 'release', indexPath: 'wiki/index.json',
    });
  });

  it('copies a destination block from another wiki config via --from-config', () => {
    const foreign = join(other, 'docs', 'wiki', '.pwiki.json');
    writeFileSync(foreign, JSON.stringify({
      primary: 'confluence', mirrors: [],
      destinations: {
        confluence: {
          kind: 'confluence', siteUrl: 'https://x.atlassian.net', spaceKey: 'ENG',
          spaceId: '123', rootPageId: '456', titlePrefix: 'Specs',
          subParents: { concept: '1', person: '2', source: '3', query: '4' },
        },
      },
    }), 'utf-8');
    const r = run(primary, 'source', 'add', 'specs', `--from-config=${foreign}`, '--no-verify');
    expect(r.status).toBe(0);
    const block = readCfg(primary).destinations.specs;
    expect(block.kind).toBe('confluence');
    expect(block.spaceId).toBe('123');
    expect(readCfg(primary).sources).toEqual(['specs']);
  });

  it('--from-config on an fs wiki derives the path from the config location', () => {
    const foreign = join(other, 'docs', 'wiki', '.pwiki.json');
    writeFileSync(foreign, JSON.stringify({ primary: 'fs', mirrors: [], destinations: { fs: { kind: 'fs' } } }), 'utf-8');
    const r = run(primary, 'source', 'add', 'specs', `--from-config=${foreign}`);
    expect(r.status).toBe(0);
    const block = readCfg(primary).destinations.specs;
    expect(block.kind).toBe('fs');
    expect(resolve(primary, block.path)).toBe(resolve(other));
  });

  it('refuses a name that is already a destination', () => {
    const r = run(primary, 'source', 'add', 'fs', '--kind=fs', `--path=${other}`);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.out).error.code).toBe('source-exists');
  });

  it('refuses an unknown kind', () => {
    const r = run(primary, 'source', 'add', 'specs', '--kind=svn');
    expect(r.status).toBe(1);
    expect(JSON.parse(r.out).error.code).toBe('bad-args');
  });

  it('refuses --kind=fs without --path', () => {
    const r = run(primary, 'source', 'add', 'specs', '--kind=fs');
    expect(r.status).toBe(1);
    expect(JSON.parse(r.out).error.code).toBe('bad-args');
  });

  it('refuses an unreachable fs source and leaves the config untouched', () => {
    const before = readFileSync(join(primary, 'docs', 'wiki', '.pwiki.json'), 'utf-8');
    const r = run(primary, 'source', 'add', 'specs', '--kind=fs', `--path=${join(other, 'nope')}`);
    expect(r.status).toBe(1);
    const json = JSON.parse(r.out);
    expect(json.error.code).toBe('source-unreachable');
    expect(json.error.message).toMatch(/--no-verify/);
    expect(readFileSync(join(primary, 'docs', 'wiki', '.pwiki.json'), 'utf-8')).toBe(before);
  });

  it('refuses to add a source that duplicates the primary role', () => {
    // 'fs' is taken, so use a fresh name pointing at our own root — allowed by config
    // validation, but the name/role check must still keep primary and mirrors distinct.
    const cfg = readCfg(primary);
    cfg.mirrors = ['backup'];
    cfg.destinations.backup = { kind: 'fs', path: other };
    writeFileSync(join(primary, 'docs', 'wiki', '.pwiki.json'), JSON.stringify(cfg), 'utf-8');
    const r = run(primary, 'source', 'add', 'backup', '--kind=fs', `--path=${other}`);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.out).error.code).toBe('source-exists');
  });
});
