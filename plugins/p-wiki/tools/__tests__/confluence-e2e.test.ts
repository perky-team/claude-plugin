import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHttpClient } from '../lib/confluence/http.mjs';
import { createConfluenceDestination } from '../lib/destinations/confluence.mjs';
import { ensureSubParent } from '../lib/confluence/tree.mjs';
import { request as httpsRequest } from 'node:https';

const skip = !process.env.PWIKI_E2E_CONFLUENCE;

// Confluence's full-text search index is eventually-consistent — a page is not
// searchable by `text ~` for some seconds after it's created. Poll briefly so
// the search step isn't flaky. (Identity/structure reads use the children API,
// which is read-your-writes, so only full-text search needs this.)
async function pollUntil<T>(fn: () => Promise<T>, ok: (v: T) => boolean, tries = 40, delayMs = 3000): Promise<T> {
  let last = await fn();
  for (let i = 1; i < tries && !ok(last); i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    last = await fn();
  }
  return last;
}

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
    dest = createConfluenceDestination({ root: '/tmp', destinationConfig: config.confluence, transport: realTransport });
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

    // 2. search — best-effort. Confluence's full-text index is eventually
    // consistent and can lag a write by minutes, so we verify the search CALL
    // works (no 400, valid shape; a broken CQL would throw and fail here) and
    // confirm the hit only if the index has caught up within the poll window.
    // Result correctness is covered deterministically by the unit suite.
    const s = await pollUntil(() => dest.search(conceptTitle, {}), (r: any) => r.total > 0, 10);
    expect(Array.isArray(s.results)).toBe(true);
    if (s.total > 0) {
      expect(s.results.find((r: any) => r.path === `confluence://concept/${conceptSlug}`)).toBeDefined();
    } else {
      console.warn(`[e2e] full-text search did not index "${conceptTitle}" within the poll window (Confluence indexing latency, not a code defect)`);
    }

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

  it('multi-destination scenario: configure FS mirror, sync, delete one source page, resync', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwiki-e2e-sync-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs', 'wiki'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'docs', 'wiki', 'CLAUDE.md'), 'e2e placeholder', 'utf-8');

      const spaceKey = process.env.PWIKI_E2E_SPACE_KEY!;
      const spaceIdRes = await http.get(`/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`);
      const spaceId = spaceIdRes.body.results[0].id;

      fs.writeFileSync(path.join(tmpDir, 'docs', 'wiki', '.pwiki.json'), JSON.stringify({
        primary: 'confluence',
        mirrors: ['fs'],
        destinations: {
          confluence: {
            kind: 'confluence',
            siteUrl: process.env.PWIKI_E2E_SITE_URL,
            spaceKey,
            spaceId,
            rootPageId: process.env.PWIKI_E2E_ROOT_PAGE_ID,
            subParents: dest._config.subParents,
          },
          fs: { kind: 'fs' },
        },
      }, null, 2), 'utf-8');

      const stamp = Date.now().toString();

      const aSlug = `e2e-mirror-a-${stamp}`;
      const bSlug = `e2e-mirror-b-${stamp}`;
      // Create B first so A's portable cross-link to B resolves to a real
      // Confluence URL at write time (Confluence drops an unresolved
      // confluence:// href to "#"; a single direct write can't forward-reference).
      await dest.writePage({
        type: 'concept', slug: bSlug,
        frontmatter: { id: bSlug, type: 'concept', title: 'Mirror B', created: '2026-05-18', updated: '2026-05-18', status: 'active', tags: [], sources: [] },
        body: `# Mirror B\n`,
      });
      createdIds.push(dest._identity.get('concept', bSlug));
      await dest.writePage({
        type: 'concept', slug: aSlug,
        frontmatter: { id: aSlug, type: 'concept', title: 'Mirror A', created: '2026-05-18', updated: '2026-05-18', status: 'active', tags: [], sources: [] },
        body: `# Mirror A\n\nLink: [B](confluence://concept/${bSlug})\n`,
      });
      createdIds.push(dest._identity.get('concept', aSlug));

      const { spawnSync } = await import('node:child_process');
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      const cliPath = require.resolve('../pwiki.mjs');
      const r = spawnSync('node', [cliPath, 'sync', '--format=json'], { cwd: tmpDir, encoding: 'utf-8', env: process.env });
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.ok).toBe(true);
      expect(out.mirrors[0].name).toBe('fs');
      expect(out.mirrors[0].written).toBeGreaterThanOrEqual(2);

      // FS mirror has the two pages with rewritten relative cross-links.
      const aBody = fs.readFileSync(path.join(tmpDir, 'docs', 'wiki', 'pages', 'concept', `${aSlug}.md`), 'utf-8');
      expect(aBody).toContain(`](${bSlug}.md)`);
      expect(fs.existsSync(path.join(tmpDir, 'docs', 'wiki', 'index.md'))).toBe(true);

      // Delete one source page in Confluence, resync, FS mirror loses it.
      await dest.deletePage(`confluence://concept/${aSlug}`);
      const r2 = spawnSync('node', [cliPath, 'sync', '--format=json'], { cwd: tmpDir, encoding: 'utf-8', env: process.env });
      expect(r2.status, r2.stderr).toBe(0);
      const out2 = JSON.parse(r2.stdout);
      expect(out2.mirrors[0].deleted).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(path.join(tmpDir, 'docs', 'wiki', 'pages', 'concept', `${aSlug}.md`))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'docs', 'wiki', 'pages', 'concept', `${bSlug}.md`))).toBe(true);
    } finally {
      const fs = await import('node:fs');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 240_000);

  // Regression guard for the `property[...]` CQL bug: Confluence Cloud rejects
  // identity/role resolution by content property with HTTP 400. The scenario
  // above warms the identity cache via writePage, so it never exercises a COLD
  // lookup. This test builds a brand-new destination (empty cache, empty
  // sub-parents) and resolves an existing page from scratch — the exact path
  // (`findByRole` + `ensureIdentityIndex`) that used to 400 live.
  it('cold-cache identity + role resolution works live (no property[...] CQL)', async () => {
    const stamp = Date.now().toString();
    const today = new Date().toISOString().slice(0, 10);
    const slug = `e2e-cold-${stamp}`;
    const title = `E2E Cold ${stamp}`;

    // Seed with the warm destination from beforeAll.
    await dest.writePage({
      type: 'concept', slug,
      frontmatter: { id: slug, type: 'concept', title, created: today, updated: today, status: 'active', tags: [], sources: [] },
      body: `# ${title}\n\nCold-cache resolution probe.\n`,
    });
    const createdId = dest._identity.get('concept', slug);
    expect(createdId).toBeDefined();
    createdIds.push(createdId);

    // Fresh destination: empty identity cache AND empty sub-parents, so it must
    // rediscover everything from Confluence using only supported CQL.
    const coldConfig = { ...dest._config, subParents: {} as Record<string, string> };
    const cold = createConfluenceDestination({ root: '/tmp', destinationConfig: coldConfig, transport: realTransport });

    // ensureStructure → ensureSubParent → findByRole (ancestor scan + property
    // reads). Must rediscover the EXISTING sub-parents, not create duplicates.
    await cold.ensureStructure();
    expect(cold._config.subParents.concept).toBe(dest._config.subParents.concept);
    expect(cold._config.subParents.query).toBe(dest._config.subParents.query);

    // Cold identity resolution (ensureIdentityIndex scan) finds the page.
    expect(await cold.pageExists({ type: 'concept', slug })).toBe(true);
    expect(cold._identity.get('concept', slug)).toBe(createdId);

    const read = await cold.readPage(`confluence://concept/${slug}`);
    expect(read.frontmatter.title).toBe(title);

    // Cold delete resolves through the same scan, then the page is gone.
    const del = await cold.deletePage(`confluence://concept/${slug}`);
    expect(del.deleted).toBe(true);
    expect(await cold.pageExists({ type: 'concept', slug })).toBe(false);

    // Already deleted — drop from the afterAll cleanup list.
    const idx = createdIds.indexOf(createdId);
    if (idx >= 0) createdIds.splice(idx, 1);
  }, 180_000);

  // The CLI command handlers must `await` the (async) Confluence destination —
  // a missing await makes `new`/`set`/etc. operate on a Promise and silently
  // report "not created". Drive the real CLI binary end-to-end to lock that in
  // and to prove read-back through `pwiki get` works against live Confluence.
  it('CLI binary works live: init → new → get → set → get', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const { spawnSync } = await import('node:child_process');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const cliPath = require.resolve('../pwiki.mjs');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwiki-e2e-cli-'));
    const run = (...a: string[]) => spawnSync('node', [cliPath, ...a], { cwd: tmpDir, encoding: 'utf-8', env: process.env });
    const stamp = Date.now().toString();
    const slug = `e2e-cli-${stamp}`;
    const title = `E2E CLI ${stamp}`;
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs', 'wiki'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'docs', 'wiki', 'CLAUDE.md'), 'e2e placeholder', 'utf-8');

      const init = run('init', '--confluence', `--site=${process.env.PWIKI_E2E_SITE_URL}`, `--space=${process.env.PWIKI_E2E_SPACE_KEY}`, `--parent=${process.env.PWIKI_E2E_ROOT_PAGE_ID}`);
      expect(init.status, init.stderr).toBe(0);

      const created = run('new', 'concept', `--title=${title}`, `--slug=${slug}`, '--tags=e2e,cli');
      expect(created.status, created.stderr).toBe(0);
      expect(JSON.parse(created.stdout).created).toBe(true);

      // Read back via the CLI (the path the user asked to verify).
      const got = run('get', `confluence://concept/${slug}`, '--format=json');
      expect(got.status, got.stderr).toBe(0);
      const page = JSON.parse(got.stdout);
      expect(page.frontmatter.title).toBe(title);
      expect(page.frontmatter.tags).toEqual(['e2e', 'cli']);
      expect(page.body).toContain(title);

      // Mutate, then re-read to confirm persistence + read-your-writes.
      const set = run('set', `confluence://concept/${slug}`, '--add-tag=verified');
      expect(set.status, set.stderr).toBe(0);
      const got2 = run('get', `confluence://concept/${slug}`, '--format=json');
      expect(got2.status, got2.stderr).toBe(0);
      expect(JSON.parse(got2.stdout).frontmatter.tags).toContain('verified');
    } finally {
      // Clean up via a FRESH destination: the page was created by the CLI
      // subprocess, so `dest`'s memoized identity index wouldn't see it. A cold
      // instance re-scans and resolves it.
      try {
        const cleanup = createConfluenceDestination({ root: '/tmp', destinationConfig: dest._config, transport: realTransport });
        await cleanup.deletePage(`confluence://concept/${slug}`);
      } catch { /* ignore */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 180_000);
});
