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
