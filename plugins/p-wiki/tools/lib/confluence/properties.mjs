export function createPropertiesHelper(http) {
  const cache = new Map(); // pageId -> Map<key, {id, version}>

  async function loadList(pageId) {
    if (cache.has(pageId)) return cache.get(pageId);
    const res = await http.get(`/wiki/api/v2/pages/${pageId}/properties`);
    const map = new Map();
    for (const p of res.body?.results ?? []) {
      map.set(p.key, { id: p.id, version: p.version?.number ?? 1 });
    }
    cache.set(pageId, map);
    return map;
  }

  // Re-fetch the properties list from the server and update the cache entry.
  // Used by upsert's 409-retry path and by readAll to keep versions fresh.
  async function refreshList(pageId) {
    const res = await http.get(`/wiki/api/v2/pages/${pageId}/properties`);
    const map = cache.get(pageId) ?? new Map();
    for (const p of res.body?.results ?? []) {
      map.set(p.key, { id: p.id, version: p.version?.number ?? 1 });
    }
    cache.set(pageId, map);
    return map;
  }

  async function upsert(pageId, key, value) {
    const list = await loadList(pageId);
    const existing = list.get(key);
    if (existing) {
      const newVersion = existing.version + 1;
      try {
        await http.put(`/wiki/api/v2/pages/${pageId}/properties/${existing.id}`, {
          key, value, version: { number: newVersion },
        });
        list.set(key, { id: existing.id, version: newVersion });
      } catch (e) {
        if (e.status === 409) {
          // Re-fetch current version and retry once (mirrors the single-retry in
          // the page-body PUT path in destinations/confluence.mjs).
          const refreshed = await refreshList(pageId);
          const cur = refreshed.get(key);
          if (!cur) throw e; // property disappeared; rethrow original
          const retryVersion = cur.version + 1;
          await http.put(`/wiki/api/v2/pages/${pageId}/properties/${cur.id}`, {
            key, value, version: { number: retryVersion },
          });
          refreshed.set(key, { id: cur.id, version: retryVersion });
        } else {
          throw e;
        }
      }
    } else {
      const res = await http.post(`/wiki/api/v2/pages/${pageId}/properties`, { key, value });
      list.set(key, { id: res.body.id, version: 1 });
    }
  }

  async function readAll(pageId) {
    await loadList(pageId);
    // Fetch fresh values from the server and update the cached version map so
    // subsequent upsert calls start from the current version (not a stale one).
    const res = await http.get(`/wiki/api/v2/pages/${pageId}/properties`);
    const map = cache.get(pageId) ?? new Map();
    const out = {};
    for (const p of res.body?.results ?? []) {
      map.set(p.key, { id: p.id, version: p.version?.number ?? 1 });
      out[p.key] = p.value;
    }
    cache.set(pageId, map);
    return out;
  }

  async function remove(pageId, key) {
    const list = await loadList(pageId);
    const existing = list.get(key);
    if (!existing) return false;
    await http.delete(`/wiki/api/v2/pages/${pageId}/properties/${existing.id}`);
    list.delete(key);
    return true;
  }

  function invalidate(pageId) { cache.delete(pageId); }

  return { upsert, remove, readAll, invalidate };
}
