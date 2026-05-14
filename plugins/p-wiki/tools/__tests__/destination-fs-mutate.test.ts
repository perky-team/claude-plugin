import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-fs-mut-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
  writeFileSync(join(dir, 'docs', 'wiki', 'pages', 'concept', 'foo.md'),
    `---\nid: foo\ntype: concept\ntitle: Foo\ncreated: 2026-05-01\nupdated: 2026-05-01\nstatus: active\ntags: [a]\nsources: []\n---\n\n# Foo\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fs.readPage', () => {
  it('reads frontmatter and body by repo-relative path', () => {
    const dest = createFsDestination({ rootPath: dir });
    const r = dest.readPage('docs/wiki/pages/concept/foo.md');
    expect(r.frontmatter.id).toBe('foo');
    expect(r.body).toMatch(/# Foo/);
  });
});

describe('fs.mutatePage', () => {
  it('bumps updated and adds source', () => {
    const dest = createFsDestination({ rootPath: dir });
    const r = dest.mutatePage('docs/wiki/pages/concept/foo.md', {
      bumpUpdated: true,
      addSources: ['raw/articles/x.md'],
    });
    expect(r.changed).toEqual(expect.arrayContaining(['updated', 'sources']));
    expect(r.noop).toBe(false);
    const text = readFileSync(join(dir, r.path), 'utf-8');
    expect(text).toContain('updated: ');
    expect(text).toContain('raw/articles/x.md');
  });

  it('dedups when adding existing source', () => {
    const dest = createFsDestination({ rootPath: dir });
    dest.mutatePage('docs/wiki/pages/concept/foo.md', { addSources: ['raw/x.md'] });
    const r = dest.mutatePage('docs/wiki/pages/concept/foo.md', { addSources: ['raw/x.md'] });
    expect(r.changed).not.toContain('sources');
  });

  it('returns noop=true when nothing changed', () => {
    const dest = createFsDestination({ rootPath: dir });
    const r = dest.mutatePage('docs/wiki/pages/concept/foo.md', {});
    expect(r.noop).toBe(true);
    expect(r.changed).toEqual([]);
  });

  it('throws on file not found', () => {
    const dest = createFsDestination({ rootPath: dir });
    expect(() => dest.readPage('docs/wiki/pages/concept/missing.md'))
      .toThrow(/not found/i);
  });
});
