import { describe, expect, it, vi } from 'vitest';
import { syncLabels } from '../lib/confluence/labels.mjs';

function fakeHttp(currentLabels: string[]) {
  const state = new Set(currentLabels);
  return {
    state,
    get: vi.fn(async (p: string) => ({ status: 200, body: { results: [...state].map(name => ({ name })) } })),
    post: vi.fn(async (p: string, body: any) => { for (const t of body) state.add(t.name); return { status: 200 }; }),
    delete: vi.fn(async (p: string) => {
      const m = /\?name=(.+)$/.exec(p);
      if (m) state.delete(decodeURIComponent(m[1]));
      return { status: 200 };
    }),
  };
}

describe('syncLabels', () => {
  it('adds new tags, removes missing ones', async () => {
    const http = fakeHttp(['a', 'b', 'c']);
    await syncLabels(http, '100', ['b', 'c', 'd']);
    expect([...http.state].sort()).toEqual(['b', 'c', 'd']);
  });

  it('noop when target equals current', async () => {
    const http = fakeHttp(['a', 'b']);
    await syncLabels(http, '100', ['a', 'b']);
    expect(http.post).not.toHaveBeenCalled();
    expect(http.delete).not.toHaveBeenCalled();
  });

  it('handles empty target (remove all)', async () => {
    const http = fakeHttp(['a', 'b']);
    await syncLabels(http, '100', []);
    expect(http.state.size).toBe(0);
  });
});
