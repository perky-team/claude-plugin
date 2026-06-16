import { listChildren } from './children.mjs';

const SUB_PARENT_TITLES = {
  concept: 'Concepts', person: 'People', source: 'Sources', query: 'Queries',
};

const TITLE_SEP = ' — ';

// Confluence Cloud requires page titles to be unique within a space. Structural
// pages (sub-parents + index) carry fixed base titles, so two p-wikis in one
// space would collide. Namespace them with a per-wiki prefix (defaulted at init
// from the root page's title, which is itself space-unique). Discovery stays via
// the `pwiki-role` property (see findByRole), so the title is cosmetic and
// existing wikis with bare titles keep working — a missing/empty prefix yields
// the bare base title unchanged.
export function structuralTitle(baseTitle, titlePrefix) {
  return titlePrefix ? `${titlePrefix}${TITLE_SEP}${baseTitle}` : baseTitle;
}

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

export async function ensureSubParent(http, spaceId, rootPageId, type, titlePrefix) {
  const role = `sub-parent:${type}`;
  const found = await findByRole(http, rootPageId, role);
  if (found) return found;
  const title = structuralTitle(SUB_PARENT_TITLES[type], titlePrefix);
  const created = await http.post('/wiki/api/v2/pages', {
    spaceId, parentId: rootPageId, title,
    body: { representation: 'atlas_doc_format', value: JSON.stringify({ type: 'doc', version: 1, content: [] }) },
  });
  const newId = created.body.id;
  await http.post(`/wiki/api/v2/pages/${newId}/properties`, { key: 'pwiki-role', value: role });
  return newId;
}

export async function ensureIndex(http, spaceId, rootPageId, titlePrefix) {
  const found = await findByRole(http, rootPageId, 'index');
  if (found) return found;
  const created = await http.post('/wiki/api/v2/pages', {
    spaceId, parentId: rootPageId, title: structuralTitle('Index', titlePrefix),
    body: { representation: 'atlas_doc_format', value: JSON.stringify({ type: 'doc', version: 1, content: [] }) },
  });
  const newId = created.body.id;
  await http.post(`/wiki/api/v2/pages/${newId}/properties`, { key: 'pwiki-role', value: 'index' });
  return newId;
}
