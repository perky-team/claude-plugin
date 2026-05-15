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
});
