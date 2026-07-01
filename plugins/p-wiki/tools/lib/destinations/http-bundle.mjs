// plugins/p-wiki/tools/lib/destinations/http-bundle.mjs
import { rankDocuments } from '../search.mjs';

const stripSlash = (s) => String(s).replace(/\/+$/, '');
const enc = encodeURIComponent;

const PROFILES = {
  gitlab: {
    url: (c) => `${stripSlash(c.baseUrl ?? 'https://gitlab.com')}/api/v4/projects/${enc(c.project)}/repository/files/${enc(c.indexPath ?? 'docs/wiki/index.json')}?ref=${enc(c.ref ?? 'main')}`,
    header: (c, env) => { const t = env['PWIKI_GITLAB_TOKEN']; return t ? { 'PRIVATE-TOKEN': t } : {}; },
    base64: true,
  },
  github: {
    url: (c) => `${stripSlash(c.apiBaseUrl ?? 'https://api.github.com')}/repos/${c.owner}/${c.repo}/contents/${c.indexPath ?? 'docs/wiki/index.json'}${c.ref ? `?ref=${enc(c.ref)}` : ''}`,
    header: (c, env) => { const t = env['PWIKI_GITHUB_TOKEN']; return t ? { Authorization: `Bearer ${t}` } : {}; },
    base64: true,
  },
  http: {
    url: (c) => c.url,
    header: (c, env) => { if (!c.authHeader) return {}; const t = env[c.authTokenEnv]; return t ? { [c.authHeader]: t } : {}; },
    base64: false,
  },
};

export function createHttpBundleSource({ kind, destinationConfig, transport, env = process.env }) {
  const profile = PROFILES[kind];
  if (!profile) throw new Error(`unknown http-bundle kind: ${kind}`);
  const c = destinationConfig;

  async function fetchBundle() {
    const req = { method: 'GET', url: profile.url(c), headers: { Accept: 'application/json', ...profile.header(c, env) } };
    const res = await transport(req);
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`HTTP ${res.status} GET ${req.url}`);
      err.status = res.status;
      throw err;
    }
    let bundle;
    try {
      if (profile.base64) {
        const text = Buffer.from(res.body?.content ?? '', res.body?.encoding ?? 'base64').toString('utf-8');
        bundle = JSON.parse(text);
      } else {
        bundle = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
      }
    } catch {
      const err = new Error('bundle is not valid JSON'); err.code = 'bundle-invalid'; throw err;
    }
    if (!bundle || bundle.schema !== 1 || !Array.isArray(bundle.pages)) {
      const err = new Error('bundle schema unsupported'); err.code = 'bundle-invalid'; throw err;
    }
    return bundle;
  }

  async function search(query, opts = {}) {
    const bundle = await fetchBundle();
    let docs = bundle.pages.map(p => ({ path: p.path, frontmatter: p.frontmatter, body: p.body }));
    if (opts.type?.length) docs = docs.filter(d => opts.type.includes(d.frontmatter.type));
    if (opts.tags?.length) docs = docs.filter(d => (d.frontmatter.tags ?? []).some(t => opts.tags.includes(t)));
    const results = rankDocuments(query, docs, { limit: opts.limit ?? 10, snippet: opts.snippet ?? true });
    return { total: results.length, results };
  }

  async function readPage(repoRelPath) {
    const bundle = await fetchBundle();
    const page = bundle.pages.find(p => p.path === repoRelPath);
    if (!page) throw new Error(`page not found: ${repoRelPath}`);
    return { frontmatter: page.frontmatter, body: page.body, path: page.path };
  }

  return { kind, search, readPage };
}
