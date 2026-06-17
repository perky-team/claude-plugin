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

  it('filters by type in memory (no property CQL): matching type keeps the hit', async () => {
    const dest = setup();
    const r = await dest.search('kafka', { type: ['concept'] });
    expect(r.total).toBe(1);
    expect(r.results[0].path).toBe('confluence://concept/kafka');
  });

  it('filters by type in memory: non-matching type drops the hit', async () => {
    const dest = setup();
    const r = await dest.search('kafka', { type: ['person'] });
    expect(r.total).toBe(0);
    expect(r.results).toEqual([]);
  });
});

describe('Confluence search — pagination', () => {
  // Pagination scenario: 12 pages all match the query, but only the LAST 5
  // have pwiki-type='concept'. The first page (limit=3) returns 3 non-concept
  // pages; without pagination `search` would return 0 concept results even
  // though there are 5 more pages of results. WITH pagination it must keep
  // following `_links.next` until it has collected `limit` concept results.
  it('pages through results to collect exactly `limit` type-filtered matches', async () => {
    const fake = createFakeConfluence({ spaces: [{ id: 'S1', key: 'ENG', name: 'Eng' }] });
    // Sub-parent pages (structural, no pwiki-id so they won't count as results)
    for (const [type, id] of Object.entries({ concept: '101', person: '102', source: '103', query: '104' })) {
      fake.pageById.set(id, { id, title: type, parentId: '100', version: 1, body: { type: 'doc', version: 1, content: [] }, properties: new Map(), labels: new Set() });
    }
    // Seed 7 'person' pages first (IDs 300-306) — they match the query but
    // won't pass the concept type filter. Then 5 'concept' pages (307-311).
    // Page size = 3, so to accumulate 3 concept matches the caller must fetch
    // at least 4 pages (pages 1-3 are all person hits).
    for (let i = 0; i < 7; i++) {
      const id = String(300 + i);
      fake.pageById.set(id, {
        id, title: `Person ${i}`, parentId: '102', version: 1,
        body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'pagtest entry' }] }] },
        properties: new Map([
          ['pwiki-id', { id: `pi${i}`, key: 'pwiki-id', value: `person-${i}`, version: 1 }],
          ['pwiki-type', { id: `pt${i}`, key: 'pwiki-type', value: 'person', version: 1 }],
        ]),
        labels: new Set(),
      });
    }
    for (let i = 0; i < 5; i++) {
      const id = String(400 + i);
      fake.pageById.set(id, {
        id, title: `Concept ${i}`, parentId: '101', version: 1,
        body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'pagtest entry' }] }] },
        properties: new Map([
          ['pwiki-id', { id: `ci${i}`, key: 'pwiki-id', value: `concept-${i}`, version: 1 }],
          ['pwiki-type', { id: `ct${i}`, key: 'pwiki-type', value: 'concept', version: 1 }],
        ]),
        labels: new Set(),
      });
    }
    process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
    process.env.PWIKI_CONFLUENCE_TOKEN = 't';
    const dest = createConfluenceDestination({
      root: '/tmp',
      destinationConfig: { siteUrl: 'https://x', spaceKey: 'ENG', spaceId: 'S1', rootPageId: '100', subParents: { concept: '101', person: '102', source: '103', query: '104' } },
      transport: fake.transport,
    });
    // Limit=3 raw results per page. We filter for type='concept'. Without
    // pagination the first page (3 person hits) yields 0 concept results.
    // With pagination we page until we find 3 concept results.
    const r = await dest.search('pagtest', { type: ['concept'], limit: 3 });
    expect(r.results).toHaveLength(3);
    expect(r.results.every(x => x.type === 'concept')).toBe(true);
  });
});
