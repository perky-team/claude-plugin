export function escapeCqlText(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function typeDisjunction(types) {
  if (!types?.length) return '';
  return '(' + types.map(t => `property["pwiki-type"] = "${t}"`).join(' OR ') + ')';
}

function tagConjunction(tags) {
  if (!tags?.length) return '';
  return tags.map(t => `labels = "${escapeCqlText(t)}"`).join(' AND ');
}

export function buildSearchCql({ query, rootPageId, types, tags }) {
  const parts = [`text ~ "${escapeCqlText(query)}"`, `ancestor = ${rootPageId}`];
  const td = typeDisjunction(types); if (td) parts.push(td);
  const tc = tagConjunction(tags); if (tc) parts.push(tc);
  return parts.join(' AND ');
}

export function buildListCql({ rootPageId, types }) {
  const parts = [`ancestor = ${rootPageId}`];
  const td = typeDisjunction(types ?? ['concept', 'person', 'source', 'query']);
  if (td) parts.push(td);
  return parts.join(' AND ');
}

export function mapSearchResult(hit) {
  const c = hit.content ?? hit;
  return {
    id: c.id,
    title: c.title,
    excerpt: hit.excerpt ?? '',
    score: hit.score ?? 0,
  };
}
