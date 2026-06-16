import { describe, expect, it } from 'vitest';
import { findByRole, ensureSubParent, ensureIndex, structuralTitle } from '../lib/confluence/tree.mjs';
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

  it('structuralTitle prefixes with " — ", and is a no-op without a prefix', () => {
    expect(structuralTitle('Concepts', 'My Wiki')).toBe('My Wiki — Concepts');
    expect(structuralTitle('Index', 'My Wiki')).toBe('My Wiki — Index');
    expect(structuralTitle('Concepts', undefined)).toBe('Concepts');
    expect(structuralTitle('Concepts', '')).toBe('Concepts');
  });

  it('two wikis in one space collide on bare titles, succeed with a prefix', async () => {
    const { http, fake } = makeHttp([
      { id: '200', title: 'Root A', parentId: null },
      { id: '300', title: 'Root B', parentId: null },
    ]);
    // First wiki under Root A claims "Concepts" space-wide.
    await ensureSubParent(http, 'S1', '200', 'concept');
    // Second wiki under Root B, no prefix → POST "Concepts" in the same space → 400.
    await expect(ensureSubParent(http, 'S1', '300', 'concept')).rejects.toMatchObject({ status: 400 });
    // With a per-wiki prefix the title is unique and creation succeeds.
    const id = await ensureSubParent(http, 'S1', '300', 'concept', 'Root B');
    expect(fake.pageById.get(id)?.title).toBe('Root B — Concepts');
    expect(fake.pageById.get(id)?.properties.get('pwiki-role')?.value).toBe('sub-parent:concept');
  });

  it('ensureIndex applies the prefix and avoids space-wide collisions', async () => {
    const { http, fake } = makeHttp([
      { id: '200', title: 'Root A', parentId: null },
      { id: '300', title: 'Root B', parentId: null },
    ]);
    await ensureIndex(http, 'S1', '200');                       // bare "Index"
    await expect(ensureIndex(http, 'S1', '300')).rejects.toMatchObject({ status: 400 });
    const id = await ensureIndex(http, 'S1', '300', 'Root B');
    expect(fake.pageById.get(id)?.title).toBe('Root B — Index');
    expect(fake.pageById.get(id)?.properties.get('pwiki-role')?.value).toBe('index');
  });

  it('backwards compat: existing role-matched container is reused, not renamed (prefix ignored)', async () => {
    const { http, fake } = makeHttp([
      { id: '200', title: 'Root', parentId: null },
      { id: '500', title: 'Concepts', parentId: '200', properties: [{ key: 'pwiki-role', value: 'sub-parent:concept' }] },
    ]);
    const sizeBefore = fake.pageById.size;
    const id = await ensureSubParent(http, 'S1', '200', 'concept', 'Some Prefix');
    expect(id).toBe('500');                                     // found by role
    expect(fake.pageById.size).toBe(sizeBefore);               // no new page
    expect(fake.pageById.get('500')?.title).toBe('Concepts');  // not renamed
  });
});
