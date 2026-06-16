import { createHttpClient } from '../confluence/http.mjs';
import { createIdentityCache, parsePath, formatPath } from '../confluence/identity.mjs';
import { createPropertiesHelper } from '../confluence/properties.mjs';
import { markdownToAdf, adfToMarkdown } from '../confluence/adf.mjs';
import { syncLabels } from '../confluence/labels.mjs';
import { buildSearchCql, mapSearchResult } from '../confluence/search.mjs';
import { listChildren } from '../confluence/children.mjs';
import { rewriteCrossLinks } from '../cross-links.mjs';
import { withDateSuffix } from '../slug.mjs';
import { today, toRepoRelative } from '../paths.mjs';
import { parseFrontmatter } from '../fm.mjs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { runConfluenceLint } from '../confluence/lint.mjs';
import { ensureIndex, ensureSubParent } from '../confluence/tree.mjs';
import { renderIndexAdf } from '../confluence/index.mjs';
import { join } from 'node:path';

export function createConfluenceDestination({ root, config, destinationConfig, transport }) {
  // TODO(Task 4 cleanup): drop {config} fallback once nothing in-tree uses it.
  const c = destinationConfig ?? config.confluence;
  const email = process.env.PWIKI_CONFLUENCE_EMAIL;
  const token = process.env.PWIKI_CONFLUENCE_TOKEN;
  if (!email || !token) {
    if (!transport) throw new Error('PWIKI_CONFLUENCE_EMAIL / PWIKI_CONFLUENCE_TOKEN required');
  }
  const http = createHttpClient({ baseUrl: c.siteUrl, email: email ?? 'test', token: token ?? 'test', transport });
  const identity = createIdentityCache();
  const properties = createPropertiesHelper(http);

  const nyi = (name) => () => { throw new Error(`ConfluenceDestination.${name}: not implemented`); };

  function pathFor({ type, slug }) {
    return formatPath(type, slug);
  }

  // Confluence Cloud CQL cannot resolve a page by its content properties
  // (pwiki-id / pwiki-type) — `property[...]` returns HTTP 400. So we can't
  // query identity directly. Instead scan pages under the root via the
  // supported `ancestor` field, read each page's properties, and populate the
  // identity cache in memory. Built at most once per run, so a sync touching
  // many pages pays the property reads only once.
  let identityIndexBuilt = false;
  async function ensureIdentityIndex() {
    if (identityIndexBuilt) return;
    // Content pages live directly under their type's sub-parent. Enumerate each
    // sub-parent's children via the read-your-writes children API (CQL search
    // lags writes), read properties, and populate the identity cache.
    const seenScopes = new Set();
    for (const subParent of Object.values(c.subParents)) {
      if (!subParent || seenScopes.has(subParent)) continue;
      seenScopes.add(subParent);
      for (const child of await listChildren(http, subParent)) {
        const props = await properties.readAll(child.id);
        const pid = props['pwiki-id'];
        const ptype = props['pwiki-type'];
        if (pid && ptype) identity.set(ptype, pid, child.id);
      }
    }
    identityIndexBuilt = true;
  }

  async function pageExists({ type, slug }) {
    if (identity.get(type, slug)) return true;
    await ensureIdentityIndex();
    return identity.get(type, slug) !== undefined;
  }

  function viewUrl(numericId) {
    return `${c.siteUrl}/wiki/spaces/${c.spaceKey}/pages/${numericId}`;
  }

  function fmToPropertyPairs(fm) {
    const pairs = [];
    const map = {
      id: 'pwiki-id', type: 'pwiki-type', title: 'pwiki-title',
      created: 'pwiki-created', updated: 'pwiki-updated', status: 'pwiki-status',
      'source-url': 'pwiki-source-url', 'source-type': 'pwiki-source-type',
      question: 'pwiki-question', 'conflict-since': 'pwiki-conflict-since',
    };
    for (const [k, v] of Object.entries(fm)) {
      if (v === undefined || v === null) continue;
      if (k === 'tags' || k === 'sources' || k === 'informed-by') {
        pairs.push([`pwiki-${k}`, JSON.stringify(v ?? [])]);
      } else if (map[k]) {
        pairs.push([map[k], String(v)]);
      }
    }
    return pairs;
  }

  async function writePage({ type, slug, frontmatter, body, onConflict }) {
    const conflict = onConflict ?? 'fail';
    let useSlug = slug;

    const exists = await pageExists({ type, slug: useSlug });
    if (exists) {
      if (conflict === 'fail') {
        const numericId = identity.get(type, useSlug);
        return {
          path: '', id: useSlug, slug: useSlug, created: false,
          existingPath: formatPath(type, useSlug),
          existingViewUrl: viewUrl(numericId),
          dateSuffixSlug: withDateSuffix(slug, today()),
        };
      }
      if (conflict === 'date-suffix') {
        useSlug = withDateSuffix(slug, today());
        if (await pageExists({ type, slug: useSlug })) {
          const numericId = identity.get(type, useSlug);
          return {
            path: '', id: useSlug, slug: useSlug, created: false,
            existingPath: formatPath(type, useSlug),
            existingViewUrl: viewUrl(numericId),
            dateSuffixSlug: useSlug,
          };
        }
      }
      // overwrite: fall through
    }

    const adf = markdownToAdf(rewriteBodyForStorage(body, formatPath(type, useSlug)));
    const fm = { ...frontmatter, id: useSlug };
    const pairs = fmToPropertyPairs(fm);

    let pageId;
    if (exists && conflict === 'overwrite') {
      pageId = identity.get(type, useSlug);
      // GET current version
      const cur = await http.get(`/wiki/api/v2/pages/${pageId}`);
      const curVersion = cur.body.version.number;
      // Try PUT, one auto-retry on 409
      const putBody = (v) => ({
        id: pageId, status: 'current', title: fm.title,
        version: { number: v },
        body: { representation: 'atlas_doc_format', value: JSON.stringify(adf) },
      });
      try {
        await http.put(`/wiki/api/v2/pages/${pageId}`, putBody(curVersion + 1));
      } catch (e) {
        if (e.status === 409) {
          const c2 = await http.get(`/wiki/api/v2/pages/${pageId}`);
          await http.put(`/wiki/api/v2/pages/${pageId}`, putBody(c2.body.version.number + 1));
        } else { throw e; }
      }
    } else {
      const created = await http.post('/wiki/api/v2/pages', {
        spaceId: c.spaceId, parentId: c.subParents[type], title: fm.title,
        body: { representation: 'atlas_doc_format', value: JSON.stringify(adf) },
      });
      pageId = created.body.id;
      identity.set(type, useSlug, pageId);
      properties.invalidate(pageId);
    }

    // Upsert properties
    for (const [key, value] of pairs) await properties.upsert(pageId, key, value);

    // Sync labels
    await syncLabels(http, pageId, fm.tags ?? []);

    return {
      path: formatPath(type, useSlug),
      id: useSlug, slug: useSlug,
      created: true,
      viewUrl: viewUrl(pageId),
    };
  }

  function reassembleFm(properties) {
    const fm = {};
    const tags = properties['pwiki-tags']; if (tags !== undefined) fm.tags = JSON.parse(tags);
    const sources = properties['pwiki-sources']; if (sources !== undefined) fm.sources = JSON.parse(sources);
    const ib = properties['pwiki-informed-by']; if (ib !== undefined) fm['informed-by'] = JSON.parse(ib);
    const scalarMap = {
      'pwiki-id': 'id', 'pwiki-type': 'type', 'pwiki-title': 'title',
      'pwiki-created': 'created', 'pwiki-updated': 'updated', 'pwiki-status': 'status',
      'pwiki-source-url': 'source-url', 'pwiki-source-type': 'source-type', 'pwiki-question': 'question',
      'pwiki-conflict-since': 'conflict-since',
    };
    for (const [k, v] of Object.entries(properties)) {
      if (scalarMap[k] && v !== undefined) fm[scalarMap[k]] = v;
    }
    return fm;
  }

  async function listConfluencePages(types) {
    // List content pages as the direct children of each type's sub-parent via
    // the read-your-writes children API (CQL `ancestor` search lags writes and
    // would make sync miss freshly written pages). Filter by pwiki-type in
    // memory; `!fm.type` drops structural pages (sub-parents, index).
    const wanted = types && types.length ? types : ['concept', 'person', 'source', 'query'];
    const typeFilter = types && types.length ? new Set(types) : null;
    const out = [];
    const seenScopes = new Set();
    for (const type of wanted) {
      const subParent = c.subParents[type];
      if (!subParent || seenScopes.has(subParent)) continue;
      seenScopes.add(subParent);
      for (const child of await listChildren(http, subParent)) {
        const props = await properties.readAll(child.id);
        const fm = reassembleFm(props);
        if (!fm.type) continue;
        if (typeFilter && !typeFilter.has(fm.type)) continue;
        identity.set(fm.type, fm.id, child.id);
        out.push({ path: formatPath(fm.type, fm.id), frontmatter: fm });
      }
    }
    return out;
  }

  function listRawFs() {
    // Raw is always on FS even in Confluence mode.
    const rawDir = join(root, 'docs', 'wiki', 'raw');
    if (!existsSync(rawDir)) return [];
    const out = [];
    const stack = [rawDir];
    while (stack.length) {
      const cur = stack.pop();
      for (const ent of readdirSync(cur, { withFileTypes: true })) {
        const p = join(cur, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else if (ent.isFile() && p.endsWith('.md')) {
          try {
            const text = readFileSync(p, 'utf-8');
            const { frontmatter } = parseFrontmatter(text);
            out.push({ path: toRepoRelative(root, p), frontmatter });
          } catch { /* skip */ }
        }
      }
    }
    return out;
  }

  async function listPages(opts) {
    const where = opts?.in ?? 'pages';
    const pagesPart = (where === 'pages' || where === 'all') ? await listConfluencePages(opts?.types) : [];
    const rawPart = (where === 'raw' || where === 'all') ? listRawFs() : [];
    return [...pagesPart, ...rawPart];
  }

  async function readPage(path) {
    const { type, slug } = parsePath(path);
    let id = identity.get(type, slug);
    if (!id) {
      await pageExists({ type, slug });
      id = identity.get(type, slug);
      if (!id) throw new Error(`page not found: ${path}`);
    }
    const pageRes = await http.get(`/wiki/api/v2/pages/${id}?body-format=atlas_doc_format`);
    const adfStr = pageRes.body?.body?.atlas_doc_format?.value;
    const adf = adfStr ? JSON.parse(adfStr) : { type: 'doc', version: 1, content: [] };
    const body = adfToMarkdown(adf);
    const props = await properties.readAll(id);
    const frontmatter = reassembleFm(props);
    return { frontmatter, body, path };
  }

  function applyMutations(fm, mutations) {
    const newFm = { ...fm };
    const changed = [];
    if (mutations.setFields) {
      for (const [k, v] of Object.entries(mutations.setFields)) {
        if (newFm[k] !== v) { newFm[k] = v; changed.push(k); }
      }
    }
    if (mutations.addTag) {
      const tags = newFm.tags ?? [];
      if (!tags.includes(mutations.addTag)) { newFm.tags = [...tags, mutations.addTag]; changed.push('tags'); }
    }
    if (mutations.removeTag) {
      const tags = newFm.tags ?? [];
      if (tags.includes(mutations.removeTag)) { newFm.tags = tags.filter(t => t !== mutations.removeTag); changed.push('tags'); }
    }
    if (mutations.addSources) {
      const src = newFm.sources ?? [];
      const added = mutations.addSources.filter(s => !src.includes(s));
      if (added.length) { newFm.sources = [...src, ...added]; changed.push('sources'); }
    }
    if (mutations.addInformedBy) {
      const ib = newFm['informed-by'] ?? [];
      const added = mutations.addInformedBy.filter(s => !ib.includes(s));
      if (added.length) { newFm['informed-by'] = [...ib, ...added]; changed.push('informed-by'); }
    }
    if (mutations.bumpUpdated) {
      const t = today();
      if (newFm.updated !== t) { newFm.updated = t; changed.push('updated'); }
    }
    if (mutations.removeFields) {
      for (const k of mutations.removeFields) {
        if (k in newFm) { delete newFm[k]; changed.push(k); }
      }
    }
    return { newFm, changed: [...new Set(changed)] };
  }

  async function mutatePage(path, mutations) {
    const { type, slug } = parsePath(path);
    let id = identity.get(type, slug);
    if (!id) { await pageExists({ type, slug }); id = identity.get(type, slug); }
    if (!id) throw new Error(`page not found: ${path}`);

    const props = await properties.readAll(id);
    const fm = reassembleFm(props);
    const { newFm, changed } = applyMutations(fm, mutations);
    const hasBody = typeof mutations.setBody === 'string';
    if (changed.length === 0 && !hasBody) return { path, changed: [], noop: true };

    // Diff: only upsert properties whose serialized value differs from current.
    const newPairs = fmToPropertyPairs(newFm);
    const oldPairs = new Map(fmToPropertyPairs(fm));
    for (const [key, value] of newPairs) {
      if (oldPairs.get(key) !== value) await properties.upsert(id, key, value);
    }
    // Removed fields: actually DELETE the matching property.
    if (mutations.removeFields) {
      const fmKeyToPropKey = { question: 'pwiki-question', 'informed-by': 'pwiki-informed-by', tags: 'pwiki-tags', sources: 'pwiki-sources', 'conflict-since': 'pwiki-conflict-since' };
      for (const k of mutations.removeFields) {
        const propKey = fmKeyToPropKey[k];
        if (propKey && props[propKey] !== undefined) await properties.remove(id, propKey);
      }
    }
    if (changed.includes('tags')) await syncLabels(http, id, newFm.tags ?? []);

    if (hasBody) {
      const cur = await http.get(`/wiki/api/v2/pages/${id}`);
      const ver = cur.body?.version?.number ?? 1;
      const adf = markdownToAdf(rewriteBodyForStorage(mutations.setBody, path));
      try {
        await http.put(`/wiki/api/v2/pages/${id}`, {
          id, status: 'current',
          title: cur.body?.title,
          spaceId: c.spaceId,
          body: { representation: 'atlas_doc_format', value: JSON.stringify(adf) },
          version: { number: ver + 1 },
        });
      } catch (e) {
        if (e.status === 409) {
          // single auto-retry on version conflict
          const cur2 = await http.get(`/wiki/api/v2/pages/${id}`);
          const ver2 = cur2.body?.version?.number ?? 1;
          await http.put(`/wiki/api/v2/pages/${id}`, {
            id, status: 'current',
            title: cur2.body?.title,
            spaceId: c.spaceId,
            body: { representation: 'atlas_doc_format', value: JSON.stringify(adf) },
            version: { number: ver2 + 1 },
          });
        } else {
          throw e;
        }
      }
      changed.push('body');
    }

    return { path, changed, noop: false };
  }

  async function search(query, opts = {}) {
    // Type isn't a CQL filter (no property search); tags map to labels, which
    // CQL supports. Filter by type in memory below.
    const cql = buildSearchCql({
      query, rootPageId: c.rootPageId, tags: opts.tags,
    });
    const limit = opts.limit ?? 10;
    const res = await http.get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=excerpt`);
    const typeFilter = opts.type && opts.type.length ? new Set(opts.type) : null;
    const results = [];
    for (const hit of res.body?.results ?? []) {
      const m = mapSearchResult(hit);
      const props = await properties.readAll(m.id);
      const fm = reassembleFm(props);
      if (!fm.type) continue;
      if (typeFilter && !typeFilter.has(fm.type)) continue;
      identity.set(fm.type, fm.id, m.id);
      results.push({
        path: formatPath(fm.type, fm.id),
        title: fm.title, type: fm.type, tags: fm.tags ?? [],
        score: m.score, snippet: m.excerpt,
      });
    }
    const total = typeFilter ? results.length : (res.body?.totalSize ?? results.length);
    return { total, results };
  }

  async function movePage(fromPath, toPath) {
    const from = parsePath(fromPath);
    const to = parsePath(toPath);
    let id = identity.get(from.type, from.slug);
    if (!id) { await pageExists({ type: from.type, slug: from.slug }); id = identity.get(from.type, from.slug); }
    if (!id) throw new Error(`page not found: ${fromPath}`);

    // body-format is required — a v2 page GET omits the body otherwise, which
    // would make the move write back an empty document (wiping the page).
    const cur = await http.get(`/wiki/api/v2/pages/${id}?body-format=atlas_doc_format`);
    const curVersion = cur.body.version.number;
    const title = cur.body.title;
    const adfStr = cur.body?.body?.atlas_doc_format?.value;

    const putBody = {
      id, status: 'current', title,
      version: { number: curVersion + 1 },
      parentId: c.subParents[to.type],
      body: adfStr ? { representation: 'atlas_doc_format', value: adfStr } : { representation: 'atlas_doc_format', value: JSON.stringify({ type: 'doc', version: 1, content: [] }) },
    };
    await http.put(`/wiki/api/v2/pages/${id}`, putBody);

    await properties.upsert(id, 'pwiki-id', to.slug);
    await properties.upsert(id, 'pwiki-type', to.type);
    identity.set(to.type, to.slug, id);
  }

  // Match Confluence page URLs on this site only.
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const URL_RE = new RegExp(`^${escapeRe(c.siteUrl)}/wiki/spaces/${escapeRe(c.spaceKey)}/pages/(\\d+)$`);

  function parseWikiLink(href, _fromPath) {
    if (!href) return null;
    // Portable cross-link form (the authoring format): confluence://type/slug.
    // Encodes type+slug directly, so it resolves without the identity cache.
    if (href.startsWith('confluence://')) {
      try { return parsePath(href); } catch { return null; }
    }
    const m = URL_RE.exec(href);
    if (!m) return null;
    const numericId = m[1];
    const hit = identity.getByNumericId(numericId);
    if (!hit) return null;
    return { type: hit.type, slug: hit.slug };
  }

  // Rewrite cross-links in a body to this space's native page URLs before
  // storing. Confluence sanitizes the portable `confluence://type/slug` scheme
  // to "#", so any portable (or already-native) cross-link must become a real
  // page URL first. Targets not yet created (forward references) can't resolve
  // and are left verbatim — create the target first, or let sync's 2-pass
  // rewrite (stub then resolve) handle ordering.
  function rewriteBodyForStorage(body, selfPath) {
    const helper = { parseWikiLink, formatWikiLink };
    return rewriteCrossLinks(body, helper, selfPath, helper, selfPath);
  }

  function formatWikiLink({ type, slug }, _fromPath) {
    const id = identity.get(type, slug);
    if (!id) throw new Error(`formatWikiLink: identity miss for ${type}/${slug}`);
    return `${c.siteUrl}/wiki/spaces/${c.spaceKey}/pages/${id}`;
  }

  async function deletePage(path) {
    const { type, slug } = parsePath(path);
    let id = identity.get(type, slug);
    if (!id) {
      // Resolve via the identity index (no property CQL). Cache miss + page
      // actually missing → return {deleted:false}.
      await ensureIdentityIndex();
      id = identity.get(type, slug);
      if (!id) return { deleted: false, path };
    }
    try {
      await http.delete(`/wiki/api/v2/pages/${id}`);
      // Drop from cache so subsequent pageExists hits the wire and returns false.
      identity.drop(type, slug);
      return { deleted: true, path };
    } catch (e) {
      if (e.status === 404) {
        identity.drop(type, slug);
        return { deleted: false, path };
      }
      throw e;
    }
  }

  async function lint(opts = {}) {
    return runConfluenceLint({
      http, properties,
      config: c,
      repoRoot: root, existsFn: existsSync,
    });
  }

  async function applyBacklinks({ targetPath, maxSuggestions = 20, force = false }) {
    const target = await readPage(targetPath);
    const title = (target.frontmatter.title ?? '').trim();
    if (!title) throw new Error(`applyBacklinks: target has no title: ${targetPath}`);
    const targetId = identity.get(parsePath(targetPath).type, parsePath(targetPath).slug);

    const cql = `text ~ "${title.replace(/"/g, '\\"')}" AND ancestor = ${c.rootPageId} AND id != ${targetId}`;
    const res = await http.get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${maxSuggestions + 1}`);
    const hits = res.body?.results ?? [];

    const matches = [];
    for (const hit of hits) {
      const id = hit.content?.id ?? hit.id;
      const pageRes = await http.get(`/wiki/api/v2/pages/${id}?body-format=atlas_doc_format`);
      const adfStr = pageRes.body?.body?.atlas_doc_format?.value;
      if (!adfStr) continue;
      const adf = JSON.parse(adfStr);
      const found = findFirstAdfMatch(adf, title);
      if (!found) continue;
      // Resolve the matched page's own path for accurate reporting (not the target's).
      const fm = reassembleFm(await properties.readAll(id));
      const path = fm.type && fm.id ? formatPath(fm.type, fm.id) : `confluence://${id}`;
      matches.push({ id, version: pageRes.body.version.number, adf, found, path });
    }

    if (matches.length > maxSuggestions && !force) {
      return {
        target: targetPath, title, suspicious: true, total: matches.length,
        candidates: matches.map(m => ({ file: m.path, line: -1, preview: '' })),
      };
    }

    const inserted = [];
    const href = viewUrl(targetId);
    for (const m of matches) {
      insertLinkMark(m.adf, m.found, href);
      await http.put(`/wiki/api/v2/pages/${m.id}`, {
        id: m.id, status: 'current', title: (await http.get(`/wiki/api/v2/pages/${m.id}`)).body.title,
        version: { number: m.version + 1 },
        body: { representation: 'atlas_doc_format', value: JSON.stringify(m.adf) },
      });
      inserted.push({ file: m.path, line: -1 });
    }

    return { target: targetPath, title, inserted, total: inserted.length };
  }

  function findFirstAdfMatch(adf, title) {
    const re = new RegExp(`(^|[^\\w])(${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})($|[^\\w])`);
    function walk(node, parent, idx, inCode) {
      if (!node || typeof node !== 'object') return null;
      if (node.type === 'codeBlock') return null;
      if (node.type === 'text') {
        if (inCode) return null;
        if ((node.marks ?? []).some(m => m.type === 'link' || m.type === 'code')) return null;
        const m = re.exec(node.text ?? '');
        if (m) return { parent, idx, node, start: m.index + m[1].length, len: m[2].length };
        return null;
      }
      const arr = node.content ?? [];
      for (let i = 0; i < arr.length; i++) {
        const sub = walk(arr[i], arr, i, inCode);
        if (sub) return sub;
      }
      return null;
    }
    return walk(adf, null, -1, false);
  }

  function insertLinkMark(adf, hit, href) {
    const t = hit.node.text;
    const before = t.slice(0, hit.start);
    const matched = t.slice(hit.start, hit.start + hit.len);
    const after = t.slice(hit.start + hit.len);
    const newNodes = [];
    if (before) newNodes.push({ type: 'text', text: before });
    newNodes.push({ type: 'text', text: matched, marks: [{ type: 'link', attrs: { href } }] });
    if (after) newNodes.push({ type: 'text', text: after });
    hit.parent.splice(hit.idx, 1, ...newNodes);
  }

  async function ensureStructure() {
    for (const type of ['concept', 'person', 'source', 'query']) {
      if (!c.subParents[type]) {
        c.subParents[type] = await ensureSubParent(http, c.spaceId, c.rootPageId, type);
      } else {
        // verify the cached sub-parent still exists; if not, re-create.
        try {
          await http.get(`/wiki/api/v2/pages/${c.subParents[type]}`);
        } catch (e) {
          if (e.status === 404) c.subParents[type] = await ensureSubParent(http, c.spaceId, c.rootPageId, type);
          else throw e;
        }
      }
    }
  }

  async function regenerateIndex() {
    const all = await listConfluencePages(['concept', 'person', 'source', 'query']);
    const groups = { concept: [], person: [], source: [], query: [] };
    for (const { path, frontmatter } of all) {
      const t = frontmatter.type;
      if (!(t in groups)) continue;
      const numericId = identity.get(t, frontmatter.id);
      groups[t].push({ id: frontmatter.id, title: frontmatter.title, numericId, summary: '' });
    }
    for (const k of Object.keys(groups)) {
      groups[k].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    const indexId = await ensureIndex(http, c.spaceId, c.rootPageId);
    const adf = renderIndexAdf({ siteUrl: c.siteUrl, spaceKey: c.spaceKey, groups });
    const cur = await http.get(`/wiki/api/v2/pages/${indexId}`);
    await http.put(`/wiki/api/v2/pages/${indexId}`, {
      id: indexId, status: 'current', title: 'Index',
      version: { number: cur.body.version.number + 1 },
      body: { representation: 'atlas_doc_format', value: JSON.stringify(adf) },
    });
    return {
      path: 'confluence://index',
      groups: { concept: groups.concept.length, person: groups.person.length, source: groups.source.length, query: groups.query.length },
      written: true,
    };
  }

  return {
    kind: 'confluence',
    rootPath: `${c.siteUrl}#${c.spaceKey}/${c.rootPageId}`,
    // shared internals (exposed for layered impls):
    _http: http, _config: c, _identity: identity, _properties: properties,
    pageExists,
    pathFor,
    readPage,
    writePage,
    mutatePage,
    movePage,
    deletePage,
    listPages,
    search,
    lint,
    applyBacklinks,
    regenerateIndex,
    ensureStructure,
    parseWikiLink,
    formatWikiLink,
  };
}
