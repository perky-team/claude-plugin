import { createHttpClient } from '../confluence/http.mjs';
import { createIdentityCache, parsePath, formatPath } from '../confluence/identity.mjs';
import { createPropertiesHelper } from '../confluence/properties.mjs';

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

  return {
    kind: 'confluence',
    rootPath: `${c.siteUrl}#${c.spaceKey}/${c.rootPageId}`,
    // shared internals (exposed for layered impls):
    _http: http, _config: c, _identity: identity, _properties: properties,
    pageExists,
    readPage: nyi('readPage'),
    writePage: nyi('writePage'),
    mutatePage: nyi('mutatePage'),
    movePage: nyi('movePage'),
    listPages: nyi('listPages'),
    search: nyi('search'),
    lint: nyi('lint'),
    applyBacklinks: nyi('applyBacklinks'),
    regenerateIndex: nyi('regenerateIndex'),
  };
}
