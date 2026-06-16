// Confluence Cloud's CQL search index is eventually-consistent — it lags writes
// by seconds, so a search issued right after a create/update may not see the
// change (verified live: a page is absent from `ancestor = <root>` search for
// seconds after creation). That makes CQL unusable for resolving structure or
// identity in a read-your-writes flow (init, ensureStructure, pageExists right
// after a write). The v2 children API reads the page tree from the primary
// store and IS read-your-writes consistent, so structural/identity/list reads
// go through it. CQL is reserved for genuine full-text `search` only.

function nextChildrenPath(resBody) {
  const next = resBody?._links?.next;
  if (!next) return null;
  if (/^https?:\/\//.test(next)) { const u = new URL(next); return u.pathname + u.search; }
  if (next.startsWith('/wiki/')) return next;
  if (next.startsWith('/rest/') || next.startsWith('/api/')) return `/wiki${next}`;
  return next;
}

// List the direct children of a page, following `_links.next` pagination so
// large trees aren't silently truncated. Returns `[{ id, title }]`.
export async function listChildren(http, parentId, { limit = 250 } = {}) {
  const out = [];
  let path = `/wiki/api/v2/pages/${parentId}/children?limit=${limit}`;
  let guard = 0;
  while (path && guard++ < 1000) {
    const res = await http.get(path);
    for (const c of res.body?.results ?? []) {
      const id = c.content?.id ?? c.id;
      if (id) out.push({ id: String(id), title: c.title ?? c.content?.title });
    }
    path = nextChildrenPath(res.body);
  }
  return out;
}
