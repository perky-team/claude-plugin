export async function syncLabels(http, pageId, targetTags) {
  // Page through all labels (real Confluence caps responses at ~200 per page).
  const allLabels = [];
  let path = `/wiki/rest/api/content/${pageId}/label?limit=200`;
  let guard = 0;
  while (path && guard++ < 1000) {
    const res = await http.get(path);
    for (const r of res.body?.results ?? []) allLabels.push(r.name);
    const next = res.body?._links?.next;
    if (!next) break;
    if (/^https?:\/\//.test(next)) { const u = new URL(next); path = u.pathname + u.search; }
    else if (next.startsWith('/wiki/')) { path = next; }
    else if (next.startsWith('/rest/') || next.startsWith('/api/')) { path = `/wiki${next}`; }
    else { path = next; }
  }
  const current = new Set(allLabels);
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
