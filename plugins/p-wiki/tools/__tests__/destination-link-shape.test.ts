import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';

let dir: string;
let dest: any;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-fs-links-'));
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
  dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('FS parseWikiLink / formatWikiLink', () => {
  const from = 'docs/wiki/pages/concept/foo.md';

  it('parses sibling .md as concept/<slug>', () => {
    expect(dest.parseWikiLink('./bar.md', from)).toEqual({ type: 'concept', slug: 'bar' });
    expect(dest.parseWikiLink('bar.md', from)).toEqual({ type: 'concept', slug: 'bar' });
  });

  it('parses parent traversal across types', () => {
    expect(dest.parseWikiLink('../source/baz.md', from)).toEqual({ type: 'source', slug: 'baz' });
    expect(dest.parseWikiLink('../queries/2026-05-18-q.md', from)).toEqual({ type: 'query', slug: '2026-05-18-q' });
  });

  it('returns null for external URLs, anchors, mailto', () => {
    expect(dest.parseWikiLink('https://example.com', from)).toBeNull();
    expect(dest.parseWikiLink('mailto:x@y.z', from)).toBeNull();
    expect(dest.parseWikiLink('#section', from)).toBeNull();
  });

  it('returns null for paths outside the pages tree', () => {
    expect(dest.parseWikiLink('../../raw/x.md', from)).toBeNull();
    expect(dest.parseWikiLink('../../README.md', from)).toBeNull();
  });

  it('formats a sibling link relative to the source page', () => {
    expect(dest.formatWikiLink({ type: 'concept', slug: 'bar' }, from)).toBe('bar.md');
    expect(dest.formatWikiLink({ type: 'source', slug: 'baz' }, from)).toBe('../source/baz.md');
  });
});

import { createConfluenceDestination } from '../lib/destinations/confluence.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';

describe('Confluence parseWikiLink / formatWikiLink', () => {
  let cdest: any;
  beforeAll(async () => {
    const fake = createFakeConfluence({
      spaces: [{ id: '100', key: 'ENG', name: 'Eng' }],
      initialPages: [
        { id: '200', title: 'Wiki Root', parentId: null },
        { id: '201', title: 'Concepts', parentId: '200' },
        { id: '202', title: 'People', parentId: '200' },
        { id: '203', title: 'Sources', parentId: '200' },
        { id: '204', title: 'Queries', parentId: '200' },
      ],
    });
    process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
    process.env.PWIKI_CONFLUENCE_TOKEN = 't';
    cdest = createConfluenceDestination({
      root: '/tmp/x',
      destinationConfig: {
        kind: 'confluence',
        siteUrl: 'https://example.atlassian.net',
        spaceKey: 'ENG',
        spaceId: '100',
        rootPageId: '200',
        subParents: { concept: '201', person: '202', source: '203', query: '204' },
      },
      transport: fake.transport,
    });
    // Seed the cache by writing a page (writePage populates identity)
    await cdest.writePage({
      type: 'concept', slug: 'foo',
      frontmatter: { id: 'foo', type: 'concept', title: 'Foo', created: '2026-05-18', updated: '2026-05-18', status: 'active', tags: [], sources: [] },
      body: '# Foo\n',
    });
  });

  const from = 'confluence://concept/source-page';

  it('parses Confluence URL on this site to (type, slug) using identity', () => {
    const id = cdest._identity.get('concept', 'foo');
    const href = `https://example.atlassian.net/wiki/spaces/ENG/pages/${id}`;
    expect(cdest.parseWikiLink(href, from)).toEqual({ type: 'concept', slug: 'foo' });
  });

  it('returns null for foreign siteUrl', () => {
    expect(cdest.parseWikiLink('https://other.atlassian.net/wiki/spaces/ENG/pages/123', from)).toBeNull();
  });

  it('returns null for non-URL hrefs', () => {
    expect(cdest.parseWikiLink('mailto:a@b.c', from)).toBeNull();
    expect(cdest.parseWikiLink('#anchor', from)).toBeNull();
    expect(cdest.parseWikiLink('./bar.md', from)).toBeNull();
  });

  it('formats identity to Confluence URL on this site', () => {
    const id = cdest._identity.get('concept', 'foo');
    expect(cdest.formatWikiLink({ type: 'concept', slug: 'foo' }, from)).toBe(
      `https://example.atlassian.net/wiki/spaces/ENG/pages/${id}`,
    );
  });

  it('throws on identity miss', () => {
    expect(() => cdest.formatWikiLink({ type: 'concept', slug: 'does-not-exist' }, from)).toThrow();
  });
});
