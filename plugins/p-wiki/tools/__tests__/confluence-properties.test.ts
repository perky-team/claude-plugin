import { describe, expect, it, vi } from 'vitest';
import { createPropertiesHelper } from '../lib/confluence/properties.mjs';

function fakeHttp({ enforcePropVersions = false } = {}) {
  const calls: any[] = [];
  const state = new Map<string, Array<{id: string, key: string, value: any, version: {number: number}}>>();
  // Set of propertyIds that should 409 exactly once (simulates a concurrent write).
  const oneShot409 = new Set<string>();

  function findProp(pageId: string, propId: string) {
    return (state.get(pageId) ?? []).find(p => p.id === propId);
  }

  return {
    calls,
    state,
    oneShot409,
    /** Force the next PUT for the given propertyId to return 409 once. */
    force409Once(propId: string) { oneShot409.add(propId); },
    /** Bump a property's server-side version out-of-band (simulates external write). */
    bumpPropVersion(pageId: string, key: string) {
      const arr = state.get(pageId) ?? [];
      const p = arr.find(p => p.key === key);
      if (p) p.version.number += 1;
    },
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
        const [, pageId, propId] = m;
        // One-shot 409: return 409 exactly once for this propId.
        if (oneShot409.has(propId)) {
          oneShot409.delete(propId);
          const err: any = new Error('HTTP 409 PUT ' + path);
          err.status = 409;
          throw err;
        }
        const arr = state.get(pageId) ?? [];
        const p = arr.find(p => p.id === propId);
        if (!p) return { status: 404 };
        // Version enforcement: if enabled, require body.version.number === p.version.number + 1.
        if (enforcePropVersions && body.version?.number !== p.version.number + 1) {
          const err: any = new Error('HTTP 409 PUT ' + path);
          err.status = 409;
          throw err;
        }
        p.value = body.value;
        p.version = { number: body.version?.number ?? p.version.number };
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

  it('retries PUT once on 409 by re-fetching current version', async () => {
    const http = fakeHttp();
    const h = createPropertiesHelper(http);
    // Create the property so it's in the cache at version 1.
    await h.upsert('100', 'pwiki-id', 'foo');

    // Force the next PUT for propId='1' to 409 once.
    http.force409Once('1');

    // Bump the server-side version out-of-band (simulates a concurrent writer).
    http.bumpPropVersion('100', 'pwiki-id');

    // upsert should retry after 409: re-fetch the list, then PUT with the correct version.
    await expect(h.upsert('100', 'pwiki-id', 'bar')).resolves.toBeUndefined();

    // Two PUTs total: first one 409'd, second succeeded.
    expect(http.put).toHaveBeenCalledTimes(2);
    // After retry, the helper's cached version should be updated.
    const secondPut = http.put.mock.calls[1];
    expect(secondPut[1].version.number).toBeGreaterThan(1);
  });

  it('after readAll, stale cached version does not cause upsert to 409-fail', async () => {
    // Use version enforcement so a wrong-version PUT returns 409.
    const http = fakeHttp({ enforcePropVersions: true });
    const h = createPropertiesHelper(http);

    // Create the property (version=1 on server and in cache).
    await h.upsert('100', 'pwiki-id', 'original');

    // readAll fetches a fresh GET — if it updates the cache, subsequent upsert
    // will have the right version. If it doesn't, and the server advanced, 409.
    await h.readAll('100');

    // Bump the server's version out-of-band (as if a concurrent process wrote).
    http.bumpPropVersion('100', 'pwiki-id');

    // Without the fix, upsert uses stale cached version → wrong version → 409 (thrown).
    // With the fix, readAll updated the cache (or upsert retries on 409).
    await expect(h.upsert('100', 'pwiki-id', 'updated')).resolves.toBeUndefined();
  });
});
