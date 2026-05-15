const SUB_PARENT_TITLES = {
  concept: 'Concepts', person: 'People', source: 'Sources', query: 'Queries',
};

function cqlEncode(cql) {
  return encodeURIComponent(cql);
}

export async function findByRole(http, rootPageId, role) {
  const cql = `property["pwiki-role"] = "${role}" AND ancestor = ${rootPageId}`;
  const res = await http.get(`/wiki/rest/api/search?cql=${cqlEncode(cql)}&limit=1`);
  const results = res.body?.results ?? [];
  if (results.length === 0) return null;
  return results[0].content?.id ?? results[0].id ?? null;
}

export async function ensureSubParent(http, spaceId, rootPageId, type) {
  const role = `sub-parent:${type}`;
  const found = await findByRole(http, rootPageId, role);
  if (found) return found;
  const title = SUB_PARENT_TITLES[type];
  const created = await http.post('/wiki/api/v2/pages', {
    spaceId, parentId: rootPageId, title,
    body: { representation: 'atlas_doc_format', value: JSON.stringify({ type: 'doc', version: 1, content: [] }) },
  });
  const newId = created.body.id;
  await http.post(`/wiki/api/v2/pages/${newId}/properties`, { key: 'pwiki-role', value: role });
  return newId;
}

export async function ensureIndex(http, spaceId, rootPageId) {
  const found = await findByRole(http, rootPageId, 'index');
  if (found) return found;
  const created = await http.post('/wiki/api/v2/pages', {
    spaceId, parentId: rootPageId, title: 'Index',
    body: { representation: 'atlas_doc_format', value: JSON.stringify({ type: 'doc', version: 1, content: [] }) },
  });
  const newId = created.body.id;
  await http.post(`/wiki/api/v2/pages/${newId}/properties`, { key: 'pwiki-role', value: 'index' });
  return newId;
}
