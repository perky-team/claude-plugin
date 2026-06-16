import { describe, expect, it } from 'vitest';
import { findByRole, ensureSubParent } from '../lib/confluence/tree.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';
import { createHttpClient } from '../lib/confluence/http.mjs';

// Drive tree resolution through the real fake transport, whose CQL parser
// rejects `property[...]` with HTTP 400 exactly like Confluence Cloud. This is
// what keeps findByRole honest: it must resolve roles by enumerating `ancestor`
// and reading properties, not by an unsupported property CQL.
function makeHttp(initialPages: any[] = []) {
  const fake = createFakeConfluence({ spaces: [{ id: 'S1', key: 'ENG', name: 'Eng' }], initialPages });
  const http = createHttpClient({ baseUrl: 'https://x', email: 'a', token: 'b', transport: fake.transport });
  return { http, fake };
}

describe('tree', () => {
  it('findByRole returns null when no match', async () => {
    const { http } = makeHttp([{ id: '200', title: 'Root', parentId: null }]);
    const id = await findByRole(http, '200', 'sub-parent:concept');
    expect(id).toBeNull();
  });

  it('findByRole returns id when role property matches', async () => {
    const { http } = makeHttp([
      { id: '200', title: 'Root', parentId: null },
      { id: '500', title: 'Concepts', parentId: '200', properties: [{ key: 'pwiki-role', value: 'sub-parent:concept' }] },
    ]);
    const id = await findByRole(http, '200', 'sub-parent:concept');
    expect(id).toBe('500');
  });

  it('ensureSubParent creates when missing, sets pwiki-role', async () => {
    const { http, fake } = makeHttp([{ id: '200', title: 'Root', parentId: null }]);
    const id = await ensureSubParent(http, 'S1', '200', 'concept');
    expect(id).toBeDefined();
    const p = fake.pageById.get(id);
    expect(p?.title).toBe('Concepts');
    expect(p?.properties.get('pwiki-role')?.value).toBe('sub-parent:concept');
  });

  it('ensureSubParent is idempotent (no property CQL, no duplicate page)', async () => {
    const { http, fake } = makeHttp([{ id: '200', title: 'Root', parentId: null }]);
    const id1 = await ensureSubParent(http, 'S1', '200', 'concept');
    const sizeAfterFirst = fake.pageById.size;
    const id2 = await ensureSubParent(http, 'S1', '200', 'concept');
    expect(id2).toBe(id1);
    expect(fake.pageById.size).toBe(sizeAfterFirst);
  });
});
