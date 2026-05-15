import { createHttpClient } from '../confluence/http.mjs';
import { createIdentityCache, parsePath, formatPath } from '../confluence/identity.mjs';
import { createPropertiesHelper } from '../confluence/properties.mjs';
import { markdownToAdf } from '../confluence/adf.mjs';
import { syncLabels } from '../confluence/labels.mjs';
import { withDateSuffix } from '../slug.mjs';
import { today } from '../paths.mjs';

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

  return {
    kind: 'confluence',
    rootPath: `${c.siteUrl}#${c.spaceKey}/${c.rootPageId}`,
    // shared internals (exposed for layered impls):
    _http: http, _config: c, _identity: identity, _properties: properties,
    pageExists,
    readPage: nyi('readPage'),
    writePage,
    mutatePage: nyi('mutatePage'),
    movePage: nyi('movePage'),
    listPages: nyi('listPages'),
    search: nyi('search'),
    lint: nyi('lint'),
    applyBacklinks: nyi('applyBacklinks'),
    regenerateIndex: nyi('regenerateIndex'),
  };
}
