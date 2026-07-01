import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `reindex` is only reachable through the CLI main dispatch (not exported), so
// this is a spawnSync smoke test: it must write docs/wiki/index.json as a
// schema-1 bundle of the pages/ set (raw/ excluded), regenerate index.md, and
// print the summary — the publish step consumers rely on.

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
  dir = mkdtempSync(join(tmpdir(), 'pwiki-cli-reindex-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pwiki reindex', () => {
  it('writes a schema-1 index.json of the pages/ set (raw excluded) and regenerates index.md', () => {
    writePage('docs/wiki/pages/concept/a.md', {
      id: 'a', type: 'concept', title: 'A',
      created: '2026-05-15', updated: '2026-05-15',
      status: 'active', tags: [], sources: [],
    }, '\n# A\n\nDescription A.\n');
    // A raw item must NOT appear in the bundle (bundle carries pages/ only).
    writePage('docs/wiki/raw/articles/skip.md', {
      id: 'skip', type: 'raw-article', title: 'Skip',
      'source-url': 'x', 'source-type': 'doc',
      ingested: '2026-05-15', compiled: false, 'compiled-to': [],
    }, '\n# Skip\n\nraw body.\n');

    const r = runCli(['reindex']);
    expect(r.status).toBe(0);

    const json = JSON.parse(r.stdout);
    expect(json.bundle.path).toBe('docs/wiki/index.json');
    expect(json.bundle.pages).toBe(1);
    expect(json.index.written).toBe(true);

    // index.json on disk is a valid schema-1 bundle carrying only the concept page.
    const bundle = JSON.parse(readFileSync(join(dir, 'docs/wiki/index.json'), 'utf-8'));
    expect(bundle.schema).toBe(1);
    expect(bundle.wikiRoot).toBe('docs/wiki');
    expect(bundle.pages.map((p: any) => p.id)).toEqual(['a']);
    expect(bundle.pages[0].path).toBe('docs/wiki/pages/concept/a.md');
    expect(bundle.pages[0].body).toContain('Description A.');

    // index.md is regenerated too.
    expect(existsSync(join(dir, 'docs/wiki/index.md'))).toBe(true);
  });

  it('exit 1 when run outside a p-wiki repo', () => {
    const orphan = mkdtempSync(join(tmpdir(), 'pwiki-cli-reindex-orphan-'));
    const r = spawnSync('node', [cli, 'reindex'], { cwd: orphan, encoding: 'utf-8' });
    rmSync(orphan, { recursive: true, force: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not inside a p-wiki repo/i);
  });
});
