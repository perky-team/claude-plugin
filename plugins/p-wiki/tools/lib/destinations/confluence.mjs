import { createHttpClient } from '../confluence/http.mjs';
import { createIdentityCache, parsePath, formatPath } from '../confluence/identity.mjs';
import { createPropertiesHelper } from '../confluence/properties.mjs';
import { markdownToAdf, adfToMarkdown } from '../confluence/adf.mjs';
import { syncLabels } from '../confluence/labels.mjs';
import { buildListCql, buildSearchCql, mapSearchResult } from '../confluence/search.mjs';
import { withDateSuffix } from '../slug.mjs';
import { today, toRepoRelative } from '../paths.mjs';
import { parseFrontmatter } from '../fm.mjs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { runConfluenceLint } from '../confluence/lint.mjs';
import { join } from 'node:path';

export function createConfluenceDestination({ root, config, transport }) {
  const c = config.confluence;
  const email = process.env.PWIKI_CONFLUENCE_EMAIL;
  const token = process.env.PWIKI_CONFLUENCE_TOKEN;
  if (!email || !token) {
    if (!transport) throw new Error('PWIKI_CONFLUENCE_EMAIL / PWIKI_CONFLUENCE_TOKEN required');
  }
  const http = createHttpClient({ baseUrl: c.siteUrl, email: email ?? 'test', token: token ?? 'test', transport });
  const identity = createIdentityCache();
  const properties = createPropertiesHelper(http);

  const nyi = (name) => () => { throw new Error(`ConfluenceDestination.${name}: not implemented`); };

  async function pageExists({ type, slug }) {
    const cached = identity.get(type, slug);
    if (cached) return true;
    const subParent = c.subParents[type];
    const cql = `ancestor = ${subParent} AND property["pwiki-id"] = "${slug}" AND property["pwiki-type"] = "${type}"`;
    const res = await http.get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=1`);
    const r = res.body?.results?.[0];
    if (!r) return false;
    identity.set(type, slug, r.content?.id ?? r.id);
    return true;
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
      question: 'pwiki-question',
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

    const adf = markdownToAdf(body);
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
    };
    for (const [k, v] of Object.entries(properties)) {
      if (scalarMap[k] && v !== undefined) fm[scalarMap[k]] = v;
    }
    return fm;
  }

  async function listConfluencePages(types) {
    const cql = buildListCql({ rootPageId: c.rootPageId, types });
    const res = await http.get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=250`);
    const out = [];
    for (const hit of res.body?.results ?? []) {
      const id = hit.content?.id ?? hit.id;
      if (!id) continue;
      const props = await properties.readAll(id);
      const fm = reassembleFm(props);
      if (!fm.type) continue;
      identity.set(fm.type, fm.id, id);
      out.push({ path: formatPath(fm.type, fm.id), frontmatter: fm });
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
    if (changed.length === 0) return { path, changed: [], noop: true };

    // Diff: only upsert properties whose serialized value differs from current.
    const newPairs = fmToPropertyPairs(newFm);
    const oldPairs = new Map(fmToPropertyPairs(fm));
    for (const [key, value] of newPairs) {
      if (oldPairs.get(key) !== value) await properties.upsert(id, key, value);
    }
    // Removed fields: actually DELETE the matching property.
    if (mutations.removeFields) {
      const fmKeyToPropKey = { question: 'pwiki-question', 'informed-by': 'pwiki-informed-by', tags: 'pwiki-tags', sources: 'pwiki-sources' };
      for (const k of mutations.removeFields) {
        const propKey = fmKeyToPropKey[k];
        if (propKey && props[propKey] !== undefined) await properties.remove(id, propKey);
      }
    }
    if (changed.includes('tags')) await syncLabels(http, id, newFm.tags ?? []);

    return { path, changed, noop: false };
  }

  async function search(query, opts = {}) {
    const cql = buildSearchCql({
      query, rootPageId: c.rootPageId,
      types: opts.type, tags: opts.tags,
    });
    const limit = opts.limit ?? 10;
    const res = await http.get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=excerpt`);
    const results = [];
    for (const hit of res.body?.results ?? []) {
      const m = mapSearchResult(hit);
      const props = await properties.readAll(m.id);
      const fm = reassembleFm(props);
      if (!fm.type) continue;
      identity.set(fm.type, fm.id, m.id);
      results.push({
        path: formatPath(fm.type, fm.id),
        title: fm.title, type: fm.type, tags: fm.tags ?? [],
        score: m.score, snippet: m.excerpt,
      });
    }
    return { total: res.body?.totalSize ?? results.length, results };
  }

  async function movePage(fromPath, toPath) {
    const from = parsePath(fromPath);
    const to = parsePath(toPath);
    let id = identity.get(from.type, from.slug);
    if (!id) { await pageExists({ type: from.type, slug: from.slug }); id = identity.get(from.type, from.slug); }
    if (!id) throw new Error(`page not found: ${fromPath}`);

    const cur = await http.get(`/wiki/api/v2/pages/${id}`);
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
      if (found) matches.push({ id, version: pageRes.body.version.number, adf, found });
    }

    if (matches.length > maxSuggestions && !force) {
      return {
        target: targetPath, title, suspicious: true, total: matches.length,
        candidates: matches.map(m => ({ file: formatPath(parsePath(targetPath).type, parsePath(targetPath).slug), line: -1, preview: '' })),
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
      inserted.push({ file: formatPath('concept', 'unknown'), line: -1 });
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

  return {
    kind: 'confluence',
    rootPath: `${c.siteUrl}#${c.spaceKey}/${c.rootPageId}`,
    // shared internals (exposed for layered impls):
    _http: http, _config: c, _identity: identity, _properties: properties,
    pageExists,
    readPage,
    writePage,
    mutatePage,
    movePage,
    listPages,
    search,
    lint,
    applyBacklinks,
    regenerateIndex: nyi('regenerateIndex'),
  };
}
