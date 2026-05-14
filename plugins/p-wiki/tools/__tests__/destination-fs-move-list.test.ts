import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';
import { serializeFrontmatter } from '../lib/fm.mjs';

let dir: string;
function makePage(rel: string, fm: Record<string, unknown>) {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  const body = `\n# ${fm.title}\n`;
  writeFileSync(abs, serializeFrontmatter(fm, body));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-fs-ml-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'queries'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
  makePage('docs/wiki/pages/concept/a.md', {
    id: 'a', type: 'concept', title: 'A',
    created: '2026-05-01', updated: '2026-05-01',
    status: 'active', tags: [], sources: [],
  });
  makePage('docs/wiki/pages/concept/b.md', {
    id: 'b', type: 'concept', title: 'B',
    created: '2026-05-01', updated: '2026-05-01',
    status: 'active', tags: [], sources: [],
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fs.movePage', () => {
  it('renames a file across directories', () => {
    const dest = createFsDestination({ rootPath: dir });
    dest.movePage('docs/wiki/pages/concept/a.md', 'docs/wiki/pages/queries/2026-05-14-a.md');
    expect(existsSync(join(dir, 'docs/wiki/pages/concept/a.md'))).toBe(false);
    expect(existsSync(join(dir, 'docs/wiki/pages/queries/2026-05-14-a.md'))).toBe(true);
  });
});

describe('fs.listPages', () => {
  it('lists all pages with their frontmatter', () => {
    const dest = createFsDestination({ rootPath: dir });
    const r = dest.listPages();
    expect(r).toHaveLength(2);
    expect(r.map((p: { frontmatter: { id: string } }) => p.frontmatter.id).sort()).toEqual(['a', 'b']);
  });

  it('filters by type', () => {
    const dest = createFsDestination({ rootPath: dir });
    const r = dest.listPages({ types: ['concept'] });
    expect(r.every((p: { frontmatter: { type: string } }) => p.frontmatter.type === 'concept')).toBe(true);
  });

  it('includes raw/ pages when in=all', () => {
    makePage('docs/wiki/raw/articles/x.md', {
      id: 'x', type: 'raw-article', title: 'X',
      'source-url': 'https://x.test', 'source-type': 'article',
      ingested: '2026-05-01', compiled: false, 'compiled-to': [],
    });
    const dest = createFsDestination({ rootPath: dir });
    const all = dest.listPages({ in: 'all' });
    expect(all.some((p: { frontmatter: { id: string } }) => p.frontmatter.id === 'x')).toBe(true);
  });
});
