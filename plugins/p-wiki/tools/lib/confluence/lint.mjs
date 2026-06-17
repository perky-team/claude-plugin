import { adfToMarkdown } from './adf.mjs';

export async function runConfluenceLint({ http, properties, config, repoRoot, existsFn }) {
  const errors = {};
  const warnings = {};
  const totals = { errors: 0, warnings: 0 };
  function addErr(check, item) { (errors[check] ??= []).push(item); totals.errors++; }
  function addWarn(check, item) { (warnings[check] ??= []).push(item); totals.warnings++; }

  // 1) Walk all pages under rootPageId via CQL: ancestor = rootPageId.
  // Paginate following `_links.next` so large wikis aren't silently truncated.
  const cql = `ancestor = ${config.rootPageId}`;
  const hits = [];
  let searchPath = `/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=250`;
  let searchGuard = 0;
  while (searchPath && searchGuard++ < 1000) {
    const res = await http.get(searchPath);
    for (const h of res.body?.results ?? []) hits.push(h);
    const next = res.body?._links?.next;
    if (!next) break;
    if (/^https?:\/\//.test(next)) { const u = new URL(next); searchPath = u.pathname + u.search; }
    else if (next.startsWith('/wiki/')) { searchPath = next; }
    else if (next.startsWith('/rest/') || next.startsWith('/api/')) { searchPath = `/wiki${next}`; }
    else { searchPath = next; }
  }

  // Build page info table
  const subParentIds = new Set(Object.values(config.subParents));
  const pages = [];
  for (const hit of hits) {
    const id = hit.content?.id ?? hit.id;
    if (!id) continue;
    const props = await properties.readAll(id);
    pages.push({ id, title: hit.content?.title ?? hit.title, props });
  }

  // Re-fetch each page for parentId (needed for misparented).
  for (const p of pages) {
    const pageRes = await http.get(`/wiki/api/v2/pages/${p.id}`);
    p.parentId = String(pageRes.body?.parentId ?? '');
  }

  for (const p of pages) {
    // skip structural artifacts
    if (p.props['pwiki-role']) continue;

    // drift: in tree without pwiki-id
    if (!p.props['pwiki-id']) {
      addWarn('drift', { id: p.id, title: p.title, parentId: p.parentId });
      continue;
    }

    // misparented: pwiki-type does not match parent sub-parent
    const expectedParent = config.subParents[p.props['pwiki-type']];
    if (subParentIds.has(p.parentId) && expectedParent && p.parentId !== expectedParent) {
      addErr('misparented', { id: p.id, title: p.title, pwikiType: p.props['pwiki-type'], parentId: p.parentId });
    }

    // frontmatter: pwiki-type unknown
    if (!['concept', 'person', 'source', 'query'].includes(p.props['pwiki-type'])) {
      addErr('frontmatter', { id: p.id, title: p.title, error: `unknown pwiki-type: ${p.props['pwiki-type']}` });
    }

    // stale: updated > N days ago (default 180 — match v1 lint.mjs behavior)
    const updated = p.props['pwiki-updated'];
    if (updated) {
      const days = Math.floor((Date.now() - new Date(updated).getTime()) / (1000 * 60 * 60 * 24));
      if (days > 180) addWarn('stale', { id: p.id, title: p.title, updated, days });
    }

    // dead-sources: every entry in sources: must exist on FS.
    if (repoRoot && existsFn) {
      try {
        const sources = JSON.parse(p.props['pwiki-sources'] ?? '[]');
        for (const s of sources) {
          if (!existsFn(`${repoRoot}/${s}`)) addErr('dead-sources', { id: p.id, source: s });
        }
      } catch { /* malformed JSON: covered by frontmatter check */ }
    }
  }

  // dead-links / orphan-pages / underlinked: single walk of bodies.
  const bodyCache = new Map();
  async function getBody(id) {
    if (bodyCache.has(id)) return bodyCache.get(id);
    const pageRes = await http.get(`/wiki/api/v2/pages/${id}?body-format=atlas_doc_format`);
    const adfStr = pageRes.body?.body?.atlas_doc_format?.value;
    const adf = adfStr ? JSON.parse(adfStr) : { type: 'doc', version: 1, content: [] };
    bodyCache.set(id, adf);
    return adf;
  }
  function collectLinks(node, out) {
    if (Array.isArray(node?.marks)) {
      for (const m of node.marks) {
        if (m.type === 'link' && m.attrs?.href) out.push(m.attrs.href);
      }
    }
    if (Array.isArray(node?.content)) for (const c of node.content) collectLinks(c, out);
  }
  const incoming = new Map();
  const outgoing = new Map();
  const pwikiPagesById = new Map(pages.filter(p => p.props['pwiki-id']).map(p => [p.id, p]));

  for (const p of pwikiPagesById.values()) {
    const adf = await getBody(p.id);
    const hrefs = [];
    collectLinks(adf, hrefs);
    outgoing.set(p.id, 0);
    for (const href of hrefs) {
      const m = /\/wiki\/spaces\/[^/]+\/pages\/(\d+)/.exec(href);
      if (!m) continue;                                 // external URL
      const targetId = m[1];
      outgoing.set(p.id, (outgoing.get(p.id) ?? 0) + 1);
      const target = pwikiPagesById.get(targetId);
      if (!target) addErr('dead-links', { id: p.id, href });
      else {
        incoming.set(targetId, (incoming.get(targetId) ?? 0) + 1);
      }
    }
  }

  // orphan-pages: concept pages with 0 incoming
  for (const p of pwikiPagesById.values()) {
    if (p.props['pwiki-type'] !== 'concept') continue;
    if ((incoming.get(p.id) ?? 0) === 0) addWarn('orphan-pages', { id: p.id, title: p.title });
  }

  // underlinked: concept with <3 outgoing AND status != draft
  for (const p of pwikiPagesById.values()) {
    if (p.props['pwiki-type'] !== 'concept') continue;
    if (p.props['pwiki-status'] === 'draft') continue;
    if ((outgoing.get(p.id) ?? 0) < 3) addWarn('underlinked', { id: p.id, title: p.title, outgoing: outgoing.get(p.id) ?? 0 });
  }

  return { errors, warnings, totals };
}
