import { listChildren } from './children.mjs';

const SUB_PARENT_TITLES = {
  concept: 'Concepts', person: 'People', source: 'Sources', query: 'Queries',
};

// Structural pages (sub-parents + index) carry a `pwiki-role` property and live
// directly under the root. CQL can't search by property AND its index lags
// writes, so resolving a role via search would both 400 and miss freshly
// created pages. Enumerate the root's direct children via the read-your-writes
// children API and match `pwiki-role` in memory. The child set is small (≈5).
export async function findByRole(http, rootPageId, role) {
  const children = await listChildren(http, rootPageId);
  for (const child of children) {
    const propsRes = await http.get(`/wiki/api/v2/pages/${child.id}/properties`);
    const match = (propsRes.body?.results ?? []).some(
      (p) => p.key === 'pwiki-role' && p.value === role,
    );
    if (match) return child.id;
  }
  return null;
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
