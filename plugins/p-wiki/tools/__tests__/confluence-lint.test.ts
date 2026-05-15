import { describe, expect, it } from 'vitest';
import { runConfluenceLint } from '../lib/confluence/lint.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';
import { createHttpClient } from '../lib/confluence/http.mjs';
import { createPropertiesHelper } from '../lib/confluence/properties.mjs';

function setup(extraPages: any[] = []) {
  const fake = createFakeConfluence({});
  for (const [type, id] of Object.entries({ concept: '101', person: '102', source: '103', query: '104' })) {
    fake.pageById.set(id, { id, title: type, parentId: '100', version: 1, body: { type: 'doc', version: 1, content: [] },
      properties: new Map([['pwiki-role', { id: 'r' + id, key: 'pwiki-role', value: `sub-parent:${type}`, version: 1 }]]),
      labels: new Set(),
    });
  }
  for (const p of extraPages) fake.pageById.set(p.id, p);
  process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
  process.env.PWIKI_CONFLUENCE_TOKEN = 't';
  const http = createHttpClient({ baseUrl: 'https://x', email: 'a', token: 'b', transport: fake.transport });
  const properties = createPropertiesHelper(http);
  return { http, properties, fake };
}

describe('Confluence lint', () => {
  it('drift fires on a wiki-tree page without pwiki-id', async () => {
    const { http, properties } = setup([
      { id: '500', title: 'Stray', parentId: '100', version: 1, body: { type: 'doc', version: 1, content: [] }, properties: new Map(), labels: new Set() },
    ]);
    const r = await runConfluenceLint({ http, properties, config: { rootPageId: '100', siteUrl: 'https://x', spaceKey: 'ENG', subParents: { concept: '101', person: '102', source: '103', query: '104' } } });
    expect(r.warnings.drift?.length).toBeGreaterThan(0);
    expect(r.warnings.drift[0]).toMatchObject({ id: '500' });
  });

  it('misparented fires when pwiki-type does not match parent sub-parent', async () => {
    const props = new Map([
      ['pwiki-id', { id: 'p1', key: 'pwiki-id', value: 'foo', version: 1 }],
      ['pwiki-type', { id: 'p2', key: 'pwiki-type', value: 'concept', version: 1 }],
    ]);
    const { http, properties } = setup([
      { id: '500', title: 'Foo', parentId: '103', version: 1, body: { type: 'doc', version: 1, content: [] }, properties: props, labels: new Set() },
    ]);
    const r = await runConfluenceLint({ http, properties, config: { rootPageId: '100', siteUrl: 'https://x', spaceKey: 'ENG', subParents: { concept: '101', person: '102', source: '103', query: '104' } } });
    expect(r.errors.misparented?.length).toBeGreaterThan(0);
  });

  it('skips structural artifacts (pwiki-role set)', async () => {
    const { http, properties } = setup();
    const r = await runConfluenceLint({ http, properties, config: { rootPageId: '100', siteUrl: 'https://x', spaceKey: 'ENG', subParents: { concept: '101', person: '102', source: '103', query: '104' } } });
    expect(r.warnings.drift ?? []).toEqual([]);
  });
});
