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
  return { dest: createConfluenceDestination({ root: '/tmp', destinationConfig: config.confluence, transport: fake.transport }), fake };
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

describe('Confluence mutatePage', () => {
  it('add-tag updates pwiki-tags property and labels, leaves body untouched', async () => {
    const adf = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] };
    const { dest, fake } = makeDest([
      { id: '200', title: 'Foo', parentId: '101', body: adf, version: 1,
        properties: [
          { key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' },
          { key: 'pwiki-title', value: 'Foo' }, { key: 'pwiki-created', value: '2026-05-15' },
          { key: 'pwiki-updated', value: '2026-05-15' }, { key: 'pwiki-status', value: 'active' },
          { key: 'pwiki-tags', value: '["a"]' }, { key: 'pwiki-sources', value: '[]' },
        ],
        labels: ['a'],
      },
    ]);
    const r = await dest.mutatePage('confluence://concept/foo', { addTag: 'b' });
    expect(r.changed).toContain('tags');
    expect(r.noop).toBe(false);
    const p = fake.pageById.get('200')!;
    expect(p.version).toBe(1);  // body untouched
    expect(p.properties.get('pwiki-tags')?.value).toBe('["a","b"]');
    expect([...p.labels].sort()).toEqual(['a', 'b']);
  });

  it('noop when adding an existing tag', async () => {
    const { dest } = makeDest([
      { id: '200', title: 'Foo', parentId: '101', properties: [
        { key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' },
        { key: 'pwiki-title', value: 'Foo' }, { key: 'pwiki-created', value: '2026-05-15' },
        { key: 'pwiki-updated', value: '2026-05-15' }, { key: 'pwiki-status', value: 'active' },
        { key: 'pwiki-tags', value: '["a"]' }, { key: 'pwiki-sources', value: '[]' },
      ] },
    ]);
    const r = await dest.mutatePage('confluence://concept/foo', { addTag: 'a' });
    expect(r.noop).toBe(true);
  });
});

describe('Confluence movePage', () => {
  it('reparents and updates pwiki-type/pwiki-id, preserves title and body', async () => {
    const adf = { type: 'doc', version: 1, content: [] };
    const { dest, fake } = makeDest([
      { id: '300', title: 'What is X?', parentId: '104', version: 1, body: adf,
        properties: [
          { key: 'pwiki-id', value: '2026-05-15-what-is-x' }, { key: 'pwiki-type', value: 'query' },
          { key: 'pwiki-title', value: 'What is X?' }, { key: 'pwiki-created', value: '2026-05-15' },
          { key: 'pwiki-status', value: 'filed' }, { key: 'pwiki-question', value: 'What is X?' },
          { key: 'pwiki-informed-by', value: '[]' }, { key: 'pwiki-tags', value: '[]' },
        ] },
    ]);
    await dest.movePage('confluence://query/2026-05-15-what-is-x', 'confluence://concept/what-is-x');
    const p = fake.pageById.get('300')!;
    expect(p.parentId).toBe('101');                            // moved under Concepts
    expect(p.title).toBe('What is X?');                         // title preserved
    expect(p.properties.get('pwiki-id')?.value).toBe('what-is-x');
    expect(p.properties.get('pwiki-type')?.value).toBe('concept');
  });
});
