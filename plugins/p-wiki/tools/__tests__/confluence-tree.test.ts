import { describe, expect, it, vi } from 'vitest';
import { findByRole, ensureSubParent, ensureIndex } from '../lib/confluence/tree.mjs';

function fakeHttp(initialPages: any[] = []) {
  let nextId = 1000;
  const pages = new Map(initialPages.map(p => [p.id, p]));
  return {
    pages,
    get: vi.fn(async (path: string) => {
      const m = /cql=([^&]+)/.exec(path);
      if (m) {
        const cql = decodeURIComponent(m[1]);
        const roleMatch = /property\["pwiki-role"\]\s*=\s*"([^"]+)"/.exec(cql);
        if (roleMatch) {
          const results = [...pages.values()].filter(p => p.role === roleMatch[1]);
          return { status: 200, body: { results: results.map(p => ({ content: { id: p.id, title: p.title } })) } };
        }
      }
      return { status: 200, body: { results: [] } };
    }),
    post: vi.fn(async (path: string, body: any) => {
      if (path === '/wiki/api/v2/pages') {
        const id = String(nextId++);
        pages.set(id, { id, title: body.title, parentId: body.parentId, role: null });
        return { status: 200, body: { id, title: body.title } };
      }
      if (path.includes('/properties')) {
        const m = /\/pages\/(\w+)\/properties/.exec(path);
        const p = pages.get(m![1]);
        if (p && body.key === 'pwiki-role') p.role = body.value;
        return { status: 200, body: { id: '1' } };
      }
      return { status: 404 };
    }),
  };
}

describe('tree', () => {
  it('findByRole returns null when no match', async () => {
    const http = fakeHttp();
    const id = await findByRole(http, '123', 'sub-parent:concept');
    expect(id).toBeNull();
  });

  it('findByRole returns id when role property matches', async () => {
    const http = fakeHttp([{ id: '500', title: 'Concepts', role: 'sub-parent:concept' }]);
    const id = await findByRole(http, '123', 'sub-parent:concept');
    expect(id).toBe('500');
  });

  it('ensureSubParent creates when missing, sets pwiki-role', async () => {
    const http = fakeHttp();
    const id = await ensureSubParent(http, 'SPACE1', '100', 'concept');
    expect(id).toBeDefined();
    const p = http.pages.get(id);
    expect(p?.title).toBe('Concepts');
    expect(p?.role).toBe('sub-parent:concept');
  });

  it('ensureSubParent is idempotent', async () => {
    const http = fakeHttp();
    const id1 = await ensureSubParent(http, 'SPACE1', '100', 'concept');
    const id2 = await ensureSubParent(http, 'SPACE1', '100', 'concept');
    expect(id2).toBe(id1);
    expect(http.post).toHaveBeenCalledTimes(2); // create + property
  });
});
