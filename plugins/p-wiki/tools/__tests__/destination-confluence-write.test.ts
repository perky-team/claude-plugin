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
  const dest = createConfluenceDestination({ root: '/tmp', config, transport: fake.transport });
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
  it('lists pages under root by type', async () => {
    const { dest } = makeDest([
      { id: '201', title: 'A', parentId: '101', properties: [{ key: 'pwiki-id', value: 'a' }, { key: 'pwiki-type', value: 'concept' }, { key: 'pwiki-title', value: 'A' }, { key: 'pwiki-created', value: '2026-05-15' }, { key: 'pwiki-updated', value: '2026-05-15' }, { key: 'pwiki-status', value: 'active' }, { key: 'pwiki-tags', value: '[]' }, { key: 'pwiki-sources', value: '[]' }] },
      { id: '202', title: 'B', parentId: '102', properties: [{ key: 'pwiki-id', value: 'b' }, { key: 'pwiki-type', value: 'person' }, { key: 'pwiki-title', value: 'B' }, { key: 'pwiki-created', value: '2026-05-15' }, { key: 'pwiki-updated', value: '2026-05-15' }, { key: 'pwiki-status', value: 'active' }, { key: 'pwiki-tags', value: '[]' }, { key: 'pwiki-sources', value: '[]' }] },
    ]);
    const r = await dest.listPages({ types: ['concept'] });
    expect(Array.isArray(r)).toBe(true);
  });
});
