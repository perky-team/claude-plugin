export async function syncLabels(http, pageId, targetTags) {
  const res = await http.get(`/wiki/rest/api/content/${pageId}/label`);
  const current = new Set((res.body?.results ?? []).map(r => r.name));
  const target = new Set(targetTags);

  const toAdd = [...target].filter(t => !current.has(t));
  const toRemove = [...current].filter(t => !target.has(t));

  if (toAdd.length) {
    await http.post(`/wiki/rest/api/content/${pageId}/label`, toAdd.map(name => ({ name })));
  }
  for (const t of toRemove) {
    await http.delete(`/wiki/rest/api/content/${pageId}/label?name=${encodeURIComponent(t)}`);
  }
}
