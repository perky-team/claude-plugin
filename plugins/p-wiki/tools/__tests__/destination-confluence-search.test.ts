import { describe, expect, it } from 'vitest';
import { createConfluenceDestination } from '../lib/destinations/confluence.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';

function setup() {
  const fake = createFakeConfluence({ spaces: [{ id: 'S1', key: 'ENG', name: 'Eng' }] });
  for (const [type, id] of Object.entries({ concept: '101', person: '102', source: '103', query: '104' })) {
    fake.pageById.set(id, { id, title: type, parentId: '100', version: 1, body: { type: 'doc', version: 1, content: [] }, properties: new Map(), labels: new Set() });
  }
  fake.pageById.set('200', { id: '200', title: 'Kafka', parentId: '101', version: 1, body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'kafka partitioning' }] }] }, properties: new Map([
    ['pwiki-id', { id: '1', key: 'pwiki-id', value: 'kafka', version: 1 }],
    ['pwiki-type', { id: '2', key: 'pwiki-type', value: 'concept', version: 1 }],
  ]), labels: new Set(['streaming']) });
  process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
  process.env.PWIKI_CONFLUENCE_TOKEN = 't';
  return createConfluenceDestination({
    root: '/tmp',
    destinationConfig: { siteUrl: 'https://x', spaceKey: 'ENG', spaceId: 'S1', rootPageId: '100', subParents: { concept: '101', person: '102', source: '103', query: '104' } },
    transport: fake.transport,
  });
}

describe('Confluence search', () => {
  it('finds page by text', async () => {
    const dest = setup();
    const r = await dest.search('kafka', {});
    expect(r.total).toBeGreaterThan(0);
    expect(r.results[0].path).toBe('confluence://concept/kafka');
  });

  it('filters by tag via labels CQL', async () => {
    const dest = setup();
    const r = await dest.search('kafka', { tags: ['streaming'] });
    expect(r.total).toBe(1);
  });
});
