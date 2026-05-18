import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHttpClient } from '../lib/confluence/http.mjs';
import { createConfluenceDestination } from '../lib/destinations/confluence.mjs';
import { ensureSubParent } from '../lib/confluence/tree.mjs';
import { request as httpsRequest } from 'node:https';

const skip = !process.env.PWIKI_E2E_CONFLUENCE;

function realTransport(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(req.url);
    const r = httpsRequest({ host: url.host, path: url.pathname + url.search, method: req.method, headers: req.headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let body: any = null;
        try { body = JSON.parse(buf); } catch { body = buf; }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : (v ?? '');
        resolve({ status: res.statusCode ?? 0, headers, body });
      });
    });
    r.on('error', reject);
    if (req.body) r.write(req.body);
    r.end();
  });
}

describe.skipIf(skip)('Confluence E2E', () => {
  const createdIds: string[] = [];
  let http: any;
  let dest: any;

  beforeAll(async () => {
    http = createHttpClient({
      baseUrl: process.env.PWIKI_E2E_SITE_URL!,
      email: process.env.PWIKI_CONFLUENCE_EMAIL!,
      token: process.env.PWIKI_CONFLUENCE_TOKEN!,
      transport: realTransport,
    });

    const spaceKey = process.env.PWIKI_E2E_SPACE_KEY!;
    const rootPageId = process.env.PWIKI_E2E_ROOT_PAGE_ID!;

    const spaceRes = await http.get(`/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`);
    const spaceId = spaceRes.body?.results?.[0]?.id;
    if (!spaceId) throw new Error(`E2E setup: space "${spaceKey}" not found at ${process.env.PWIKI_E2E_SITE_URL}`);

    const subParents: Record<string, string> = {};
    for (const type of ['concept', 'person', 'source', 'query']) {
      subParents[type] = await ensureSubParent(http, spaceId, rootPageId, type);
    }

    const config = {
      destination: 'confluence',
      confluence: { siteUrl: process.env.PWIKI_E2E_SITE_URL!, spaceKey, spaceId, rootPageId, subParents },
    };
    dest = createConfluenceDestination({ root: '/tmp', config, transport: realTransport });
  }, 60_000);

  afterAll(async () => {
    for (const id of createdIds.reverse()) {
      try { await http.delete(`/wiki/api/v2/pages/${id}`); } catch { /* ignore */ }
    }
  }, 60_000);

  it('end-to-end scenario: new → search → set → new query → promote → index → lint', async () => {
    const stamp = Date.now().toString();
    const today = new Date().toISOString().slice(0, 10);

    // 1. new concept
    const conceptSlug = `e2e-concept-${stamp}`;
    const conceptTitle = `E2E Concept ${stamp}`;
    const w1 = await dest.writePage({
      type: 'concept', slug: conceptSlug,
      frontmatter: { id: conceptSlug, type: 'concept', title: conceptTitle, created: today, updated: today, status: 'active', tags: [], sources: [] },
      body: `# ${conceptTitle}\n\nBody for e2e scenario.\n`,
    });
    expect(w1.created).toBe(true);
    expect(w1.path).toBe(`confluence://concept/${conceptSlug}`);
    const conceptId = dest._identity.get('concept', conceptSlug);
    expect(conceptId).toBeDefined();
    createdIds.push(conceptId);

    // 2. search
    const s = await dest.search(conceptTitle, {});
    expect(s.total).toBeGreaterThan(0);
    expect(s.results.find((r: any) => r.path === `confluence://concept/${conceptSlug}`)).toBeDefined();

    // 3. set (mutate: add tag)
    const m = await dest.mutatePage(`confluence://concept/${conceptSlug}`, { addTag: 'e2e' });
    expect(m.noop).toBe(false);
    expect(m.changed).toContain('tags');

    const reread = await dest.readPage(`confluence://concept/${conceptSlug}`);
    expect(reread.frontmatter.tags).toEqual(['e2e']);

    // 4. new query
    const querySlug = `${today}-e2e-query-${stamp}`;
    const queryTitle = `What is E2E Concept ${stamp}?`;
    const w2 = await dest.writePage({
      type: 'query', slug: querySlug,
      frontmatter: { id: querySlug, type: 'query', title: queryTitle, created: today, updated: today, status: 'filed', question: queryTitle, 'informed-by': [], tags: [], sources: [] },
      body: `# ${queryTitle}\n`,
    });
    expect(w2.created).toBe(true);
    const queryId = dest._identity.get('query', querySlug);
    createdIds.push(queryId);

    // 5. promote (movePage: query → concept)
    const promotedSlug = `e2e-promoted-${stamp}`;
    await dest.movePage(`confluence://query/${querySlug}`, `confluence://concept/${promotedSlug}`);

    expect(await dest.pageExists({ type: 'concept', slug: promotedSlug })).toBe(true);
    expect(dest._identity.get('concept', promotedSlug)).toBe(queryId);

    // 6. index (regenerateIndex)
    const r = await dest.regenerateIndex();
    expect(r.written).toBe(true);
    expect(r.path).toBe('confluence://index');
    expect(r.groups.concept).toBeGreaterThanOrEqual(2);

    // 7. lint
    const l = await dest.lint();
    expect(typeof l.totals.errors).toBe('number');
    expect(typeof l.totals.warnings).toBe('number');
  }, 180_000);
});
