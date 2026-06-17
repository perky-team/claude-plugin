import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pwiki.mjs');

let dir: string;
function runCli(args: string[]) {
  return spawnSync('node', [cli, ...args], { cwd: dir, encoding: 'utf-8' });
}

function writePage(rel: string, frontmatter: Record<string, unknown>, body: string) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const fm = Object.entries(frontmatter).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.map(x => JSON.stringify(x)).join(', ')}]`;
    if (typeof v === 'string') return `${k}: ${v}`;
    return `${k}: ${JSON.stringify(v)}`;
  }).join('\n');
  writeFileSync(abs, `---\n${fm}\n---\n${body}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-cli-index-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pwiki index', () => {
  it('exit 0 with JSON summary on success (default --format=json)', () => {
    writePage('docs/wiki/pages/concept/a.md', {
      id: 'a', type: 'concept', title: 'A',
      created: '2026-05-15', updated: '2026-05-15',
      status: 'active', tags: [], sources: [],
    }, '\n# A\n\nDescription A.\n');

    const r = runCli(['index', '--format=json']);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.path).toBe('docs/wiki/index.md');
    expect(json.groups).toEqual({ concept: 1, person: 0, source: 0, query: 0 });
    expect(json.written).toBe(true);

    const text = readFileSync(join(dir, 'docs/wiki/index.md'), 'utf-8');
    expect(text).toContain('- [A](pages/concept/a.md) — Description A.');
  });

  it('--format=text prints markdown to stdout and does NOT write index.md', () => {
    writePage('docs/wiki/pages/concept/a.md', {
      id: 'a', type: 'concept', title: 'A',
      created: '2026-05-15', updated: '2026-05-15',
      status: 'active', tags: [], sources: [],
    }, '\n# A\n\nDescription A.\n');

    const r = runCli(['index', '--format=text']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('# Wiki index');
    expect(r.stdout).toContain('- [A](pages/concept/a.md) — Description A.');
    expect(existsSync(join(dir, 'docs/wiki/index.md'))).toBe(false);
  });

  it('exit 1 when run outside a p-wiki repo', () => {
    const orphan = mkdtempSync(join(tmpdir(), 'pwiki-cli-index-orphan-'));
    const r = spawnSync('node', [cli, 'index', '--format=json'],
      { cwd: orphan, encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not inside a p-wiki repo/i);
    rmSync(orphan, { recursive: true, force: true });
  });

  it('exit 1 with --format=json hint when primary is Confluence', () => {
    const confDir = mkdtempSync(join(tmpdir(), 'pwiki-cli-index-conf-'));
    mkdirSync(join(confDir, 'docs', 'wiki'), { recursive: true });
    writeFileSync(join(confDir, 'docs', 'wiki', 'CLAUDE.md'), '# rules', 'utf-8');
    writeFileSync(join(confDir, 'docs', 'wiki', '.pwiki.json'), JSON.stringify({
      primary: 'confluence',
      mirrors: [],
      destinations: {
        confluence: {
          kind: 'confluence', siteUrl: 'https://x', spaceKey: 'ENG', spaceId: 'S1',
          rootPageId: '100', subParents: { concept: '101', person: '102', source: '103', query: '104' },
        },
      },
    }), 'utf-8');
    const r = spawnSync('node', [cli, 'index', '--format=text'], {
      cwd: confDir,
      encoding: 'utf-8',
      env: { ...process.env, PWIKI_CONFLUENCE_EMAIL: 'a@b.c', PWIKI_CONFLUENCE_TOKEN: 't' },
    });
    rmSync(confDir, { recursive: true, force: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--format=json/);
  });
});
