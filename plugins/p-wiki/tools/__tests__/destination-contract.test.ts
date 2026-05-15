import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-contract-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runContractTests(name: string, makeDest: () => any, pathShape: RegExp, indexPathShape: RegExp) {
  describe(`Destination contract: ${name}`, () => {
    it('exposes the documented method set', () => {
      const d = makeDest();
      for (const m of ['pageExists', 'readPage', 'writePage', 'mutatePage', 'movePage', 'listPages', 'search', 'lint', 'applyBacklinks', 'regenerateIndex']) {
        expect(typeof d[m]).toBe('function');
      }
      expect(typeof d.kind).toBe('string');
      expect(typeof d.rootPath).toBe('string');
    });

    it('writePage returns the documented shape', async () => {
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

    it('search returns { total, results[] }', async () => {
      const d = makeDest();
      const r = await d.search('anything', {});
      expect(typeof r.total).toBe('number');
      expect(Array.isArray(r.results)).toBe(true);
    });

    it('lint returns { errors, warnings, totals }', async () => {
      const d = makeDest();
      const r = await d.lint({});
      expect(typeof r.errors).toBe('object');
      expect(typeof r.warnings).toBe('object');
      expect(typeof r.totals.errors).toBe('number');
      expect(typeof r.totals.warnings).toBe('number');
    });

    it('applyBacklinks returns documented shape against a seeded page', async () => {
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

    it('regenerateIndex returns documented shape', async () => {
      const d = makeDest();
      const r = await d.regenerateIndex();
      expect(r.path).toMatch(indexPathShape);
      expect(typeof r.groups.concept).toBe('number');
      expect(typeof r.groups.person).toBe('number');
      expect(typeof r.groups.source).toBe('number');
      expect(typeof r.groups.query).toBe('number');
      expect(r.written).toBe(true);
    });
  });
}

runContractTests('fs', () => createFsDestination({ rootPath: dir }), /^docs\/wiki\//, /^docs\/wiki\/index\.md$/);
