import { describe, expect, it } from 'vitest';
import { createConfluenceDestination } from '../lib/destinations/confluence.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';

function makeDest(initialPages: any[] = []) {
  const fake = createFakeConfluence({
    spaces: [{ id: 'S1', key: 'ENG', name: 'Eng' }],
    initialPages,
  });
  const config = {
    destination: 'confluence',
    confluence: { siteUrl: 'https://x', spaceKey: 'ENG', spaceId: 'S1', rootPageId: '100', subParents: { concept: '101', person: '102', source: '103', query: '104' } },
  };
  process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
  process.env.PWIKI_CONFLUENCE_TOKEN = 't';
  const dest = createConfluenceDestination({ root: '/tmp', destinationConfig: config.confluence, transport: fake.transport });
  return { dest, fake };
}

describe('Confluence pageExists', () => {
  it('returns false when no page has matching pwiki-id under sub-parent', async () => {
    const { dest } = makeDest();
    expect(await dest.pageExists({ type: 'concept', slug: 'foo' })).toBe(false);
  });

  it('returns true and caches numeric id when match found', async () => {
    const { dest } = makeDest([
      { id: '200', title: 'Foo', parentId: '101', properties: [{ key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' }] },
    ]);
    expect(await dest.pageExists({ type: 'concept', slug: 'foo' })).toBe(true);
    expect(dest._identity.get('concept', 'foo')).toBe('200');
  });
});

describe('Confluence writePage', () => {
  it('creates a new page with properties and labels', async () => {
    const { dest, fake } = makeDest();
    const fm = { id: 'foo', type: 'concept', title: 'Foo', created: '2026-05-15', updated: '2026-05-15', status: 'active', tags: ['x', 'y'], sources: [] };
    const r = await dest.writePage({ type: 'concept', slug: 'foo', frontmatter: fm, body: '# Foo\n' });
    expect(r.created).toBe(true);
    expect(r.path).toBe('confluence://concept/foo');
    expect(r.viewUrl).toMatch(/\/pages\/\d+/);

    const page = [...fake.pageById.values()].find(p => p.title === 'Foo')!;
    expect(page.properties.get('pwiki-id')?.value).toBe('foo');
    expect(page.properties.get('pwiki-tags')?.value).toBe('["x","y"]');
    expect([...page.labels].sort()).toEqual(['x', 'y']);
  });

  it('fails with existingPath when slug taken and onConflict=fail', async () => {
    const { dest } = makeDest([
      { id: '200', title: 'Foo', parentId: '101', properties: [{ key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' }] },
    ]);
    const fm = { id: 'foo', type: 'concept', title: 'Foo', created: '2026-05-15', updated: '2026-05-15', status: 'active', tags: [], sources: [] };
    const r = await dest.writePage({ type: 'concept', slug: 'foo', frontmatter: fm, body: '#\n', onConflict: 'fail' });
    expect(r.created).toBe(false);
    expect(r.existingPath).toBe('confluence://concept/foo');
    expect(r.existingViewUrl).toMatch(/\/pages\/200/);
    expect(r.dateSuffixSlug).toMatch(/^foo-\d{4}-\d{2}-\d{2}$/);
  });

  it('date-suffix retries pageExists with suffixed slug', async () => {
    const { dest } = makeDest([
      { id: '200', title: 'Foo', parentId: '101', properties: [{ key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' }] },
    ]);
    const fm = { id: 'foo', type: 'concept', title: 'Foo', created: '2026-05-15', updated: '2026-05-15', status: 'active', tags: [], sources: [] };
    const r = await dest.writePage({ type: 'concept', slug: 'foo', frontmatter: fm, body: '#\n', onConflict: 'date-suffix' });
    expect(r.created).toBe(true);
    expect(r.slug).toMatch(/^foo-\d{4}-\d{2}-\d{2}$/);
  });

  it('rewrites portable confluence:// cross-links in the body to real page URLs', async () => {
    // Target page B already exists under the concept sub-parent.
    const { dest, fake } = makeDest([
      { id: '300', title: 'Beta', parentId: '101', properties: [{ key: 'pwiki-id', value: 'beta' }, { key: 'pwiki-type', value: 'concept' }] },
    ]);
    const fm = { id: 'alpha', type: 'concept', title: 'Alpha', created: '2026-05-15', updated: '2026-05-15', status: 'active', tags: [], sources: [] };
    await dest.writePage({ type: 'concept', slug: 'alpha', frontmatter: fm, body: '# Alpha\n\nSee [Beta](confluence://concept/beta).\n' });
    const page = [...fake.pageById.values()].find(p => p.title === 'Alpha')!;
    const adf = JSON.stringify(page.body);
    // Real Confluence keeps a real page URL but sanitizes confluence:// to '#'.
    expect(adf).toContain('https://x/wiki/spaces/ENG/pages/300');
    expect(adf).not.toContain('confluence://');
    expect(adf).not.toContain('"href":"#"');
  });

  it('overwrite updates body and bumps version', async () => {
    const { dest, fake } = makeDest([
      { id: '200', title: 'Foo', parentId: '101', version: 1, body: { type: 'doc', version: 1, content: [] }, properties: [{ key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' }] },
    ]);
    const fm = { id: 'foo', type: 'concept', title: 'Foo', created: '2026-05-15', updated: '2026-05-15', status: 'active', tags: [], sources: [] };
    await dest.writePage({ type: 'concept', slug: 'foo', frontmatter: fm, body: '# Updated\n', onConflict: 'overwrite' });
    const page = fake.pageById.get('200')!;
    expect(page.version).toBe(2);
    expect(page.body.content[0].type).toBe('heading');
  });
});

describe('Confluence listPages', () => {
  // Sub-parents must exist as real pages under root so the `ancestor = root`
  // scan reaches the content pages (root → sub-parent → page).
  const tree = () => [
    { id: '101', title: 'Concepts', parentId: '100' },
    { id: '102', title: 'People', parentId: '100' },
    { id: '201', title: 'A', parentId: '101', properties: [{ key: 'pwiki-id', value: 'a' }, { key: 'pwiki-type', value: 'concept' }, { key: 'pwiki-title', value: 'A' }, { key: 'pwiki-created', value: '2026-05-15' }, { key: 'pwiki-updated', value: '2026-05-15' }, { key: 'pwiki-status', value: 'active' }, { key: 'pwiki-tags', value: '[]' }, { key: 'pwiki-sources', value: '[]' }] },
    { id: '202', title: 'B', parentId: '102', properties: [{ key: 'pwiki-id', value: 'b' }, { key: 'pwiki-type', value: 'person' }, { key: 'pwiki-title', value: 'B' }, { key: 'pwiki-created', value: '2026-05-15' }, { key: 'pwiki-updated', value: '2026-05-15' }, { key: 'pwiki-status', value: 'active' }, { key: 'pwiki-tags', value: '[]' }, { key: 'pwiki-sources', value: '[]' }] },
  ];

  it('filters by type in memory (no property CQL)', async () => {
    const { dest } = makeDest(tree());
    const r = await dest.listPages({ types: ['concept'] });
    expect(r.map((p: any) => p.frontmatter.id)).toEqual(['a']);
  });

  it('returns all content types when none requested', async () => {
    const { dest } = makeDest(tree());
    const r = await dest.listPages({});
    expect(r.map((p: any) => p.frontmatter.id).sort()).toEqual(['a', 'b']);
  });
});

describe('Confluence deletePage (cold cache, no property CQL)', () => {
  it('resolves an existing page via the identity scan and deletes it', async () => {
    const { dest, fake } = makeDest([
      { id: '200', title: 'Foo', parentId: '101', properties: [{ key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' }] },
    ]);
    const r = await dest.deletePage('confluence://concept/foo');
    expect(r.deleted).toBe(true);
    expect(fake.pageById.has('200')).toBe(false);
  });

  it('returns {deleted:false} when the page does not exist', async () => {
    const { dest } = makeDest();
    const r = await dest.deletePage('confluence://concept/missing');
    expect(r.deleted).toBe(false);
  });
});
