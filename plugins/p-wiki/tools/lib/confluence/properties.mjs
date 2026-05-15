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

  async function upsert(pageId, key, value) {
    const list = await loadList(pageId);
    const existing = list.get(key);
    if (existing) {
      const newVersion = existing.version + 1;
      await http.put(`/wiki/api/v2/pages/${pageId}/properties/${existing.id}`, {
        key, value, version: { number: newVersion },
      });
      list.set(key, { id: existing.id, version: newVersion });
    } else {
      const res = await http.post(`/wiki/api/v2/pages/${pageId}/properties`, { key, value });
      list.set(key, { id: res.body.id, version: 1 });
    }
  }

  async function readAll(pageId) {
    await loadList(pageId);
    // Need the values too, not just ids — fetch fresh:
    const res = await http.get(`/wiki/api/v2/pages/${pageId}/properties`);
    const out = {};
    for (const p of res.body?.results ?? []) out[p.key] = p.value;
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
