import { describe, expect, it } from 'vitest';
import { createConfluenceDestination } from '../lib/destinations/confluence.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';

function setup(extraPages: any[] = []) {
  const fake = createFakeConfluence({ spaces: [{ id: 'S1', key: 'ENG', name: 'Eng' }] });
  for (const [type, id] of Object.entries({ concept: '101', person: '102', source: '103', query: '104' })) {
    fake.pageById.set(id, { id, title: type, parentId: '100', version: 1, body: { type: 'doc', version: 1, content: [] }, properties: new Map([['pwiki-role', { id: 'r' + id, key: 'pwiki-role', value: `sub-parent:${type}`, version: 1 }]]), labels: new Set() });
  }
  for (const p of extraPages) fake.pageById.set(p.id, p);
  process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
  process.env.PWIKI_CONFLUENCE_TOKEN = 't';
  return { fake, dest: createConfluenceDestination({
    root: '/tmp',
    destinationConfig: { siteUrl: 'https://x', spaceKey: 'ENG', spaceId: 'S1', rootPageId: '100', subParents: { concept: '101', person: '102', source: '103', query: '104' } },
    transport: fake.transport,
  }) };
}

describe('Confluence applyBacklinks', () => {
  it('inserts a link mark in each candidate body', async () => {
    const target = { id: '500', title: 'Foo', parentId: '101', version: 1, body: { type: 'doc', version: 1, content: [] },
      properties: new Map([
        ['pwiki-id', { id: 'p1', key: 'pwiki-id', value: 'foo', version: 1 }],
        ['pwiki-type', { id: 'p2', key: 'pwiki-type', value: 'concept', version: 1 }],
        ['pwiki-title', { id: 'p3', key: 'pwiki-title', value: 'Foo', version: 1 }],
      ]),
      labels: new Set(),
    };
    const candidate = { id: '600', title: 'Bar', parentId: '101', version: 1, body: { type: 'doc', version: 1, content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'We mention Foo here.' }] },
    ] },
      properties: new Map([
        ['pwiki-id', { id: 'q1', key: 'pwiki-id', value: 'bar', version: 1 }],
        ['pwiki-type', { id: 'q2', key: 'pwiki-type', value: 'concept', version: 1 }],
      ]),
      labels: new Set(),
    };
    const { dest, fake } = setup([target, candidate]);
    const r = await dest.applyBacklinks({ targetPath: 'confluence://concept/foo' });
    expect(r.inserted.length).toBe(1);
    const p = fake.pageById.get('600')!;
    const json = JSON.stringify(p.body);
    expect(json).toContain('"type":"link"');
    expect(json).toContain('/pages/500');
  });

  it('returns suspicious:true above threshold and writes nothing', async () => {
    const pages: any[] = [{ id: '500', title: 'Foo', parentId: '101', version: 1, body: { type: 'doc', version: 1, content: [] }, properties: new Map([['pwiki-id', { id: '1', key: 'pwiki-id', value: 'foo', version: 1 }], ['pwiki-type', { id: '2', key: 'pwiki-type', value: 'concept', version: 1 }], ['pwiki-title', { id: '3', key: 'pwiki-title', value: 'Foo', version: 1 }]]), labels: new Set() }];
    for (let i = 0; i < 25; i++) {
      pages.push({ id: String(700 + i), title: `P${i}`, parentId: '101', version: 1,
        body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: `mentions Foo` }] }] },
        properties: new Map([['pwiki-id', { id: `pi${i}`, key: 'pwiki-id', value: `p${i}`, version: 1 }], ['pwiki-type', { id: `pt${i}`, key: 'pwiki-type', value: 'concept', version: 1 }]]),
        labels: new Set(),
      });
    }
    const { dest, fake } = setup(pages);
    const r = await dest.applyBacklinks({ targetPath: 'confluence://concept/foo' });
    expect(r.suspicious).toBe(true);
    expect(r.total).toBeGreaterThan(20);
    for (let i = 0; i < 25; i++) expect(fake.pageById.get(String(700 + i))!.version).toBe(1);
  });
});

describe('Confluence regenerateIndex', () => {
  it('creates Index page on first run, writes ADF body, returns counts', async () => {
    const concept = { id: '500', title: 'Foo', parentId: '101', version: 1, body: { type: 'doc', version: 1, content: [] },
      properties: new Map([
        ['pwiki-id', { id: 'p1', key: 'pwiki-id', value: 'foo', version: 1 }],
        ['pwiki-type', { id: 'p2', key: 'pwiki-type', value: 'concept', version: 1 }],
        ['pwiki-title', { id: 'p3', key: 'pwiki-title', value: 'Foo', version: 1 }],
        ['pwiki-tags', { id: 'p4', key: 'pwiki-tags', value: '[]', version: 1 }],
        ['pwiki-sources', { id: 'p5', key: 'pwiki-sources', value: '[]', version: 1 }],
      ]),
      labels: new Set(),
    };
    const { dest, fake } = setup([concept]);
    const r = await dest.regenerateIndex();
    expect(r.written).toBe(true);
    expect(r.path).toBe('confluence://index');
    expect(r.groups.concept).toBe(1);
    const idx = [...fake.pageById.values()].find(p => p.title === 'Index');
    expect(idx).toBeDefined();
    expect(idx!.properties.get('pwiki-role')?.value).toBe('index');
    const bodyJson = JSON.stringify(idx!.body);
    expect(bodyJson).toContain('Concepts');
    expect(bodyJson).toContain('Foo');
  });
});
