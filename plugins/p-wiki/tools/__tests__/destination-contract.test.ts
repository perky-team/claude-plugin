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

// Generic contract runner — receives a destination factory
function runContractTests(name: string, makeDest: () => any) {
  describe(`Destination contract: ${name}`, () => {
    it('exposes the documented method set', () => {
      const d = makeDest();
      for (const m of ['pageExists', 'readPage', 'writePage', 'mutatePage', 'movePage', 'listPages', 'search', 'lint']) {
        expect(typeof d[m]).toBe('function');
      }
      expect(typeof d.kind).toBe('string');
      expect(typeof d.rootPath).toBe('string');
    });

    it('writePage returns the documented shape', () => {
      const d = makeDest();
      const r = d.writePage({
        type: 'concept', slug: 'shape',
        frontmatter: {
          id: 'shape', type: 'concept', title: 'Shape',
          created: '2026-05-14', updated: '2026-05-14',
          status: 'active', tags: [], sources: [],
        },
        body: '# Shape\n',
      });
      expect(r).toMatchObject({ created: true });
      expect(typeof r.path).toBe('string');
      expect(typeof r.id).toBe('string');
      expect(typeof r.slug).toBe('string');
    });

    it('search returns { total, results[] }', () => {
      const d = makeDest();
      const r = d.search('anything', {});
      expect(typeof r.total).toBe('number');
      expect(Array.isArray(r.results)).toBe(true);
    });

    it('lint returns { errors, warnings, totals }', () => {
      const d = makeDest();
      const r = d.lint({});
      expect(typeof r.errors).toBe('object');
      expect(typeof r.warnings).toBe('object');
      expect(typeof r.totals.errors).toBe('number');
      expect(typeof r.totals.warnings).toBe('number');
    });
  });
}

runContractTests('fs', () => createFsDestination({ rootPath: dir }));
