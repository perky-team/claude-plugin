import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';
import { createConfluenceDestination } from '../lib/destinations/confluence.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-contract-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeConfluenceDest() {
  const fake = createFakeConfluence({
    spaces: [{ id: 'S1', key: 'ENG', name: 'Eng' }],
    initialPages: [
      { id: '100', title: 'Wiki Root', parentId: null },
      { id: '101', title: 'Concepts', parentId: '100' },
      { id: '102', title: 'People', parentId: '100' },
      { id: '103', title: 'Sources', parentId: '100' },
      { id: '104', title: 'Queries', parentId: '100' },
    ],
  });
  const config = {
    destination: 'confluence',
    confluence: { siteUrl: 'https://x', spaceKey: 'ENG', spaceId: 'S1', rootPageId: '100', subParents: { concept: '101', person: '102', source: '103', query: '104' } },
  };
  process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
  process.env.PWIKI_CONFLUENCE_TOKEN = 't';
  return createConfluenceDestination({ root: '/tmp', destinationConfig: config.confluence, transport: fake.transport });
}

function runContractTests(name: string, makeDest: () => any, pathShape: RegExp, indexPathShape: RegExp, skip: Set<string> = new Set()) {
  describe(`Destination contract: ${name}`, () => {
    const t = (testName: string, fn: () => any) =>
      skip.has(testName) ? it.skip(testName, fn) : it(testName, fn);

    t('exposes the documented method set', () => {
      const d = makeDest();
      for (const m of ['pageExists', 'readPage', 'writePage', 'mutatePage', 'movePage', 'listPages', 'search', 'lint', 'applyBacklinks', 'regenerateIndex']) {
        expect(typeof d[m]).toBe('function');
      }
      expect(typeof d.kind).toBe('string');
      expect(typeof d.rootPath).toBe('string');
    });

    t('writePage returns the documented shape', async () => {
      const d = makeDest();
      const r = await d.writePage({
        type: 'concept', slug: 'shape',
        frontmatter: { id: 'shape', type: 'concept', title: 'Shape', created: '2026-05-14', updated: '2026-05-14', status: 'active', tags: [], sources: [] },
        body: '# Shape\n',
      });
      expect(r).toMatchObject({ created: true });
      expect(r.path).toMatch(pathShape);
      expect(typeof r.id).toBe('string');
      expect(typeof r.slug).toBe('string');
    });

    t('search returns { total, results[] }', async () => {
      const d = makeDest();
      const r = await d.search('anything', {});
      expect(typeof r.total).toBe('number');
      expect(Array.isArray(r.results)).toBe(true);
    });

    t('lint returns { errors, warnings, totals }', async () => {
      const d = makeDest();
      const r = await d.lint({});
      expect(typeof r.errors).toBe('object');
      expect(typeof r.warnings).toBe('object');
      expect(typeof r.totals.errors).toBe('number');
      expect(typeof r.totals.warnings).toBe('number');
    });

    t('applyBacklinks returns documented shape against a seeded page', async () => {
      const d = makeDest();
      const seed = await d.writePage({
        type: 'concept', slug: 'target',
        frontmatter: { id: 'target', type: 'concept', title: 'Target', created: '2026-05-15', updated: '2026-05-15', status: 'active', tags: [], sources: [] },
        body: '\n# Target\n',
      });
      const r = await d.applyBacklinks({ targetPath: seed.path });
      expect(typeof r.target).toBe('string');
      expect(typeof r.title).toBe('string');
      expect(typeof r.total).toBe('number');
      expect(Array.isArray(r.inserted)).toBe(true);
    });

    t('regenerateIndex returns documented shape', async () => {
      const d = makeDest();
      const r = await d.regenerateIndex();
      expect(r.path).toMatch(indexPathShape);
      expect(typeof r.groups.concept).toBe('number');
      expect(typeof r.groups.person).toBe('number');
      expect(typeof r.groups.source).toBe('number');
      expect(typeof r.groups.query).toBe('number');
      expect(r.written).toBe(true);
    });

    t('deletePage removes an existing page; pageExists is false afterward', async () => {
      const d = makeDest();
      const r = await d.writePage({
        type: 'concept', slug: 'delete-me',
        frontmatter: { id: 'delete-me', type: 'concept', title: 'Delete Me', created: '2026-05-18', updated: '2026-05-18', status: 'active', tags: [], sources: [] },
        body: '# Delete Me\n',
      });
      expect(r.created).toBe(true);
      const del = await d.deletePage(r.path);
      expect(del.deleted).toBe(true);
      expect(await d.pageExists({ type: 'concept', slug: 'delete-me' })).toBe(false);
    });

    t('deletePage is idempotent — missing page returns {deleted:false}', async () => {
      const d = makeDest();
      // Hard-code missing-path forms per backend since pathFor lands in Task 6.
      const missingPath = d.kind === 'fs'
        ? 'docs/wiki/pages/concept/never-existed.md'
        : 'confluence://concept/never-existed';
      const del = await d.deletePage(missingPath);
      expect(del.deleted).toBe(false);
    });

    t('pathFor matches what writePage returns as path for the same (type, slug)', async () => {
      const d = makeDest();
      const expected = d.pathFor({ type: 'concept', slug: 'pathfor-check' });
      const r = await d.writePage({
        type: 'concept', slug: 'pathfor-check',
        frontmatter: { id: 'pathfor-check', type: 'concept', title: 'PathFor', created: '2026-05-18', updated: '2026-05-18', status: 'active', tags: [], sources: [] },
        body: '# PathFor\n',
      });
      expect(r.path).toBe(expected);
    });

    t('pathFor is synchronous and does no I/O', () => {
      const d = makeDest();
      const p = d.pathFor({ type: 'concept', slug: 'never-written' });
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
    });
  });
}

runContractTests('fs', () => createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } }), /^docs\/wiki\//, /^docs\/wiki\/index\.md$/);

runContractTests(
  'confluence',
  makeConfluenceDest,
  /^confluence:\/\//,
  /^confluence:\/\/index$/,
);
