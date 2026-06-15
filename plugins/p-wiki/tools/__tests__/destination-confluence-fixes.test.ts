import { describe, expect, it, beforeEach } from 'vitest';
import { createConfluenceDestination } from '../lib/destinations/confluence.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';

const CONF = { siteUrl: 'https://x', spaceKey: 'ENG', spaceId: 'S1', rootPageId: '100', subParents: { concept: '101', person: '102', source: '103', query: '104' } };

function makeDest(initialPages: any[] = []) {
  const fake = createFakeConfluence({ spaces: [{ id: 'S1', key: 'ENG', name: 'Eng' }], initialPages });
  const dest = createConfluenceDestination({ root: '/tmp', destinationConfig: CONF, transport: fake.transport });
  return { dest, fake };
}

beforeEach(() => {
  process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
  process.env.PWIKI_CONFLUENCE_TOKEN = 't';
});

describe('Confluence movePage (#2 body preservation)', () => {
  it('preserves the page body across a move (requests body-format on the read)', async () => {
    const body = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'keep me' }] }] };
    const { dest, fake } = makeDest([
      { id: '300', title: 'Q', parentId: '104', version: 1, body, properties: [{ key: 'pwiki-id', value: 'q' }, { key: 'pwiki-type', value: 'query' }] },
    ]);
    await dest.movePage('confluence://query/q', 'confluence://concept/q2');
    const page = fake.pageById.get('300')!;
    expect(JSON.stringify(page.body)).toContain('keep me'); // not wiped
    expect(page.parentId).toBe('101');                       // re-parented under concept
  });
});

describe('Confluence conflict-since (#3 round-trip)', () => {
  it('persists conflict-since as a property and reads it back, then clears it', async () => {
    const { dest, fake } = makeDest([
      { id: '210', title: 'A', parentId: '101', properties: [{ key: 'pwiki-id', value: 'a' }, { key: 'pwiki-type', value: 'concept' }] },
    ]);
    await dest.mutatePage('confluence://concept/a', { setFields: { 'conflict-since': '2026-06-05' } });
    const page = fake.pageById.get('210')!;
    expect(page.properties.get('pwiki-conflict-since')?.value).toBe('2026-06-05');

    const read = await dest.readPage('confluence://concept/a');
    expect(read.frontmatter['conflict-since']).toBe('2026-06-05');

    await dest.mutatePage('confluence://concept/a', { removeFields: ['conflict-since'] });
    expect(page.properties.has('pwiki-conflict-since')).toBe(false);
  });
});

describe('Confluence listPages (#4 pagination)', () => {
  it('follows _links.next across multiple search pages', async () => {
    const props: Record<string, any[]> = {
      P1: [{ key: 'pwiki-id', value: 'p1' }, { key: 'pwiki-type', value: 'concept' }],
      P2: [{ key: 'pwiki-id', value: 'p2' }, { key: 'pwiki-type', value: 'concept' }],
    };
    let searchCalls = 0;
    const transport = async (req: any) => {
      if (req.method === 'GET' && req.path.startsWith('/wiki/rest/api/search')) {
        searchCalls++;
        if (!req.path.includes('cursor=')) {
          return { status: 200, body: { results: [{ content: { id: 'P1' } }], _links: { next: '/rest/api/search?cql=x&cursor=abc&limit=250' } } };
        }
        return { status: 200, body: { results: [{ content: { id: 'P2' } }] } };
      }
      const pm = req.path.match(/^\/wiki\/api\/v2\/pages\/(\w+)\/properties$/);
      if (req.method === 'GET' && pm) {
        return { status: 200, body: { results: props[pm[1]].map((p, i) => ({ id: String(i), key: p.key, value: p.value, version: { number: 1 } })) } };
      }
      return { status: 404, body: {} };
    };
    const dest = createConfluenceDestination({ root: '/tmp', destinationConfig: CONF, transport });
    const r = await dest.listPages({ types: ['concept'] });
    expect(r.map((p: any) => p.frontmatter.id).sort()).toEqual(['p1', 'p2']);
    expect(searchCalls).toBe(2); // first page + one follow of _links.next
  });
});
