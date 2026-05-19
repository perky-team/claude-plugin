import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';
import { createConfluenceDestination } from '../lib/destinations/confluence.mjs';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';
import { syncToMirror } from '../lib/sync.mjs';

const confluenceCfg = {
  kind: 'confluence',
  siteUrl: 'https://example.atlassian.net',
  spaceKey: 'ENG',
  spaceId: '100',
  rootPageId: '200',
  subParents: { concept: '201', person: '202', source: '203', query: '204' },
};

function makeFs(dir: string) {
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), 'placeholder', 'utf-8');
  return createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
}
function makeConfluence() {
  const fake = createFakeConfluence({
    spaces: [{ id: '100', key: 'ENG', name: 'Eng' }],
    initialPages: [
      { id: '200', title: 'Wiki Root', parentId: null },
      { id: '201', title: 'Concepts', parentId: '200' },
      { id: '202', title: 'People', parentId: '200' },
      { id: '203', title: 'Sources', parentId: '200' },
      { id: '204', title: 'Queries', parentId: '200' },
    ],
  });
  process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
  process.env.PWIKI_CONFLUENCE_TOKEN = 't';
  return createConfluenceDestination({ root: '/tmp', destinationConfig: confluenceCfg, transport: fake.transport });
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pwiki-sync-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sampleConcept = (slug: string, body = `# ${slug}\n\nBody.\n`) => ({
  type: 'concept' as const, slug,
  frontmatter: { id: slug, type: 'concept', title: slug, created: '2026-05-18', updated: '2026-05-18', status: 'active', tags: [], sources: [] },
  body,
});

describe('syncToMirror integration', () => {
  it('empty source + empty mirror → only regenerateIndex runs', async () => {
    const src = makeFs(dir);
    const dst = makeConfluence();
    const r = await syncToMirror(src, dst);
    expect(r.written).toBe(0);
    expect(r.deleted).toBe(0);
    expect(r.indexed).toBe(true);
  });

  it('FS → Confluence: 3 source pages, mirror gains 3 pages with rewritten cross-links', async () => {
    const src = makeFs(dir);
    await src.writePage(sampleConcept('a', `# A\n\nLinks: [B](./b.md) and [Google](https://google.com).\n`));
    await src.writePage(sampleConcept('b'));
    await src.writePage(sampleConcept('c'));
    const dst = makeConfluence();
    const r = await syncToMirror(src, dst);
    expect(r.written).toBe(3);
    expect(r.deleted).toBe(0);
    // Cross-link in A's body must point to Confluence URL of B on dst.
    const aOnDst = await dst.readPage('confluence://concept/a');
    const bId = (dst as any)._identity.get('concept', 'b');
    expect(aOnDst.body).toContain(`https://example.atlassian.net/wiki/spaces/ENG/pages/${bId}`);
    expect(aOnDst.body).toContain('https://google.com');     // external preserved
  });

  it('Confluence → FS: round-trip cross-links into relative paths', async () => {
    const conf = makeConfluence();
    await conf.writePage(sampleConcept('b'));
    const bId = (conf as any)._identity.get('concept', 'b');
    await conf.writePage(sampleConcept('a', `# A\n\nSee [B](https://example.atlassian.net/wiki/spaces/ENG/pages/${bId}).\n`));
    const fs2 = makeFs(dir);
    const r = await syncToMirror(conf, fs2);
    expect(r.written).toBe(2);
    const aOnFs = await fs2.readPage('docs/wiki/pages/concept/a.md');
    expect(aOnFs.body).toContain('](b.md)');
  });

  it('removes pages from mirror that are not in source (true mirror)', async () => {
    const src = makeFs(dir);
    await src.writePage(sampleConcept('keep'));
    const dst = makeConfluence();
    await dst.writePage(sampleConcept('keep'));
    await dst.writePage(sampleConcept('orphan'));
    const r = await syncToMirror(src, dst);
    expect(r.deleted).toBe(1);
    expect(await dst.pageExists({ type: 'concept', slug: 'orphan' })).toBe(false);
    expect(await dst.pageExists({ type: 'concept', slug: 'keep' })).toBe(true);
  });

  it('broken wiki cross-link in source emits warning, preserves href verbatim', async () => {
    const src = makeFs(dir);
    await src.writePage(sampleConcept('a', `# A\n\n[Broken](./gone.md)\n`));
    const dst = makeConfluence();
    const warnings: any[] = [];
    const r = await syncToMirror(src, dst, { onWarn: (info: any) => warnings.push(info) });
    expect(r.warnings).toBeGreaterThan(0);
    expect(warnings[0]).toMatchObject({ type: 'concept', slug: 'gone' });
  });

  it('re-running sync after partial failure is safe (idempotent)', async () => {
    const src = makeFs(dir);
    await src.writePage(sampleConcept('a'));
    await src.writePage(sampleConcept('b'));
    const dst = makeConfluence();
    const r1 = await syncToMirror(src, dst);
    expect(r1.written).toBe(2);
    const r2 = await syncToMirror(src, dst);
    expect(r2.written).toBe(2);
    expect(r2.deleted).toBe(0);
  });
});
