import { describe, it, expect } from 'vitest';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';
import { createHttpClient } from '../lib/confluence/http.mjs';

describe('fake-confluence sanity', () => {
  it('round-trips a page create + get', async () => {
    const fake = createFakeConfluence({ spaces: [{ id: '1', key: 'ENG', name: 'Eng' }] });
    const http = createHttpClient({ baseUrl: 'https://x', email: 'a', token: 'b', transport: fake.transport });
    const c = await http.post('/wiki/api/v2/pages', { spaceId: '1', parentId: '0', title: 'T', body: { representation: 'atlas_doc_format', value: '{"type":"doc","version":1,"content":[]}' } });
    expect(c.body.id).toBeDefined();
    const r = await http.get(`/wiki/api/v2/pages/${c.body.id}`);
    expect(r.body.title).toBe('T');
  });

  // Confluence Cloud's CQL parser cannot search content properties and returns
  // HTTP 400 "Could not parse cql". The fixture MUST reproduce that, otherwise
  // any code that resolves identity/role via a property CQL passes tests while
  // failing live. This guard is what reddens that whole class of regression.
  it('rejects property[...] CQL with HTTP 400 like real Confluence', async () => {
    const fake = createFakeConfluence({ spaces: [{ id: '1', key: 'ENG', name: 'Eng' }] });
    const http = createHttpClient({ baseUrl: 'https://x', email: 'a', token: 'b', transport: fake.transport });
    const cql = encodeURIComponent('property["pwiki-role"] = "sub-parent:concept" AND ancestor = 100');
    await expect(http.get(`/wiki/rest/api/search?cql=${cql}&limit=1`)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects content.property CQL with HTTP 400 too', async () => {
    const fake = createFakeConfluence({ spaces: [{ id: '1', key: 'ENG', name: 'Eng' }] });
    const http = createHttpClient({ baseUrl: 'https://x', email: 'a', token: 'b', transport: fake.transport });
    const cql = encodeURIComponent('content.property[pwiki-id] = "x" AND ancestor = 100');
    await expect(http.get(`/wiki/rest/api/search?cql=${cql}&limit=1`)).rejects.toMatchObject({ status: 400 });
  });

  it('still serves supported ancestor / text / labels CQL', async () => {
    const fake = createFakeConfluence({
      spaces: [{ id: '1', key: 'ENG', name: 'Eng' }],
      initialPages: [{ id: '200', title: 'Kafka', parentId: '100' }],
    });
    const http = createHttpClient({ baseUrl: 'https://x', email: 'a', token: 'b', transport: fake.transport });
    const r = await http.get(`/wiki/rest/api/search?cql=${encodeURIComponent('ancestor = 100')}&limit=250`);
    expect(r.body.results.map((h: any) => h.content.id)).toContain('200');
  });
});
