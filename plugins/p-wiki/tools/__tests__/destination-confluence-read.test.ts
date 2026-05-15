import { describe, expect, it } from 'vitest';
import { createConfluenceDestination } from '../lib/destinations/confluence.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';

function makeDest(initialPages: any[] = []) {
  const fake = createFakeConfluence({
    spaces: [{ id: 'S1', key: 'ENG', name: 'Eng' }], initialPages,
  });
  const config = {
    destination: 'confluence',
    confluence: { siteUrl: 'https://x', spaceKey: 'ENG', spaceId: 'S1', rootPageId: '100', subParents: { concept: '101', person: '102', source: '103', query: '104' } },
  };
  process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
  process.env.PWIKI_CONFLUENCE_TOKEN = 't';
  return { dest: createConfluenceDestination({ root: '/tmp', config, transport: fake.transport }), fake };
}

describe('Confluence readPage', () => {
  it('returns frontmatter + body for an existing page', async () => {
    const adf = { type: 'doc', version: 1, content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Foo' }] }] };
    const { dest } = makeDest([
      { id: '200', title: 'Foo', parentId: '101', body: adf, properties: [
        { key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' },
        { key: 'pwiki-title', value: 'Foo' }, { key: 'pwiki-created', value: '2026-05-15' },
        { key: 'pwiki-updated', value: '2026-05-15' }, { key: 'pwiki-status', value: 'active' },
        { key: 'pwiki-tags', value: '["streaming"]' }, { key: 'pwiki-sources', value: '[]' },
      ] },
    ]);
    const r = await dest.readPage('confluence://concept/foo');
    expect(r.frontmatter.title).toBe('Foo');
    expect(r.frontmatter.tags).toEqual(['streaming']);
    expect(r.body).toBe('# Foo');
    expect(r.path).toBe('confluence://concept/foo');
  });
});
