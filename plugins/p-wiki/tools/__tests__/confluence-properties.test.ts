import { describe, expect, it, vi } from 'vitest';
import { createPropertiesHelper } from '../lib/confluence/properties.mjs';

function fakeHttp() {
  const calls: any[] = [];
  const state = new Map<string, Array<{id: string, key: string, value: any, version: {number: number}}>>();
  return {
    calls,
    get: vi.fn(async (path: string) => {
      calls.push(['GET', path]);
      const m = /\/wiki\/api\/v2\/pages\/(\w+)\/properties$/.exec(path);
      if (m) return { status: 200, body: { results: state.get(m[1]) ?? [] } };
      return { status: 404 };
    }),
    post: vi.fn(async (path: string, body: any) => {
      calls.push(['POST', path, body]);
      const m = /\/wiki\/api\/v2\/pages\/(\w+)\/properties$/.exec(path);
      if (m) {
        const arr = state.get(m[1]) ?? [];
        const id = String(arr.length + 1);
        arr.push({ id, key: body.key, value: body.value, version: { number: 1 } });
        state.set(m[1], arr);
        return { status: 200, body: arr[arr.length - 1] };
      }
      return { status: 404 };
    }),
    put: vi.fn(async (path: string, body: any) => {
      calls.push(['PUT', path, body]);
      const m = /\/wiki\/api\/v2\/pages\/(\w+)\/properties\/(\w+)$/.exec(path);
      if (m) {
        const arr = state.get(m[1]) ?? [];
        const p = arr.find(p => p.id === m[2]);
        if (!p) return { status: 404 };
        p.value = body.value;
        p.version = body.version;
        return { status: 200, body: p };
      }
      return { status: 404 };
    }),
  };
}

describe('properties.upsert', () => {
  it('POSTs when key is absent', async () => {
    const http = fakeHttp();
    const h = createPropertiesHelper(http);
    await h.upsert('100', 'pwiki-id', 'foo');
    expect(http.get).toHaveBeenCalledTimes(1);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.put).not.toHaveBeenCalled();
  });

  it('PUTs (by propertyId) when key exists, increments version', async () => {
    const http = fakeHttp();
    const h = createPropertiesHelper(http);
    await h.upsert('100', 'pwiki-id', 'foo');   // creates id=1, version=1
    await h.upsert('100', 'pwiki-id', 'bar');   // updates id=1, version=2
    const putCall = http.put.mock.calls[0];
    expect(putCall[0]).toBe('/wiki/api/v2/pages/100/properties/1');
    expect(putCall[1].version.number).toBe(2);
  });

  it('reads list once per pageId (cache)', async () => {
    const http = fakeHttp();
    const h = createPropertiesHelper(http);
    await h.upsert('100', 'pwiki-id', 'foo');
    await h.upsert('100', 'pwiki-type', 'concept');
    expect(http.get).toHaveBeenCalledTimes(1);
  });
});
