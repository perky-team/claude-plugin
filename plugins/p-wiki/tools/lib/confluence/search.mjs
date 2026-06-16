export function escapeCqlText(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function tagConjunction(tags) {
  if (!tags?.length) return '';
  return tags.map(t => `labels = "${escapeCqlText(t)}"`).join(' AND ');
}

// Confluence Cloud CQL cannot filter by content property (`property[...]` →
// HTTP 400), so type filtering is NOT expressed in CQL — callers enumerate by
// `ancestor` and filter by pwiki-type in memory after reading properties.
// `labels` IS a supported CQL field, so tag intersection stays in the query.
export function buildSearchCql({ query, rootPageId, tags }) {
  const parts = [`text ~ "${escapeCqlText(query)}"`, `ancestor = ${rootPageId}`];
  const tc = tagConjunction(tags); if (tc) parts.push(tc);
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
