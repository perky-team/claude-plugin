import { describe, expect, it, vi } from 'vitest';
import { syncToMirror } from '../lib/sync.mjs';

function makeMockDest(kind: 'fs' | 'confluence', pages: any[] = []) {
  const calls: any = { ensureStructure: 0, writePage: [], mutatePage: [], deletePage: [], regenerateIndex: 0 };
  return {
    kind,
    calls,
    ensureStructure: () => { calls.ensureStructure++; },
    listPages: () => pages,
    readPage: (path: string) => {
      const p = pages.find((x: any) => x.path === path);
      return { frontmatter: p.frontmatter, body: p.body, path };
    },
    pathFor: ({ type, slug }: any) => kind === 'fs' ? `docs/wiki/pages/${type}/${slug}.md` : `confluence://${type}/${slug}`,
    parseWikiLink: () => null,
    formatWikiLink: ({ type, slug }: any, _from: string) => kind === 'fs' ? `../${type}/${slug}.md` : `https://x/wiki/spaces/E/pages/${type}-${slug}`,
    writePage: (args: any) => { calls.writePage.push(args); return { path: args.type ? `docs/wiki/pages/${args.type}/${args.slug}.md` : '?', created: true }; },
    mutatePage: (path: string, mutations: any) => { calls.mutatePage.push({ path, mutations }); return { path, changed: ['body'], noop: false }; },
    deletePage: (path: string) => { calls.deletePage.push(path); return { deleted: true, path }; },
    regenerateIndex: () => { calls.regenerateIndex++; return { path: 'docs/wiki/index.md', groups: { concept: 0, person: 0, source: 0, query: 0 }, written: true }; },
  };
}

const concept = (slug: string, body = `# ${slug}\n`) => ({
  path: `docs/wiki/pages/concept/${slug}.md`,
  frontmatter: { id: slug, type: 'concept', title: slug, created: '2026-05-18', updated: '2026-05-18', status: 'active', tags: [], sources: [] },
  body,
});

describe('syncToMirror', () => {
  it('runs ensureStructure, writes every source page (pass 1), then mutates (pass 2), then regenerates Index', async () => {
    const src = makeMockDest('fs', [concept('a'), concept('b')]);
    const dst = makeMockDest('confluence', []);
    const r = await syncToMirror(src, dst, { mirrorName: 'confluence' });
    expect(dst.calls.ensureStructure).toBe(1);
    expect(dst.calls.writePage.length).toBe(2);          // pass 1
    expect(dst.calls.mutatePage.length).toBe(2);          // pass 2
    expect(dst.calls.deletePage.length).toBe(0);
    expect(dst.calls.regenerateIndex).toBe(1);
    expect(r.written).toBe(2);
    expect(r.deleted).toBe(0);
    expect(r.warnings).toBe(0);
    expect(r.indexed).toBe(true);
  });

  it('deletes mirror-only pages (pass 3)', async () => {
    const src = makeMockDest('fs', [concept('keep')]);
    const dst = makeMockDest('confluence', [concept('keep'), concept('orphan')]);
    const r = await syncToMirror(src, dst, { mirrorName: 'confluence' });
    expect(dst.calls.deletePage.length).toBe(1);
    expect(dst.calls.deletePage[0]).toContain('orphan');
    expect(r.deleted).toBe(1);
  });

  it('caches source bodies — readPage called once per source page', async () => {
    const src = makeMockDest('fs', [concept('a'), concept('b'), concept('c')]);
    const readSpy = vi.spyOn(src, 'readPage');
    const dst = makeMockDest('confluence', []);
    await syncToMirror(src, dst, { mirrorName: 'confluence' });
    expect(readSpy).toHaveBeenCalledTimes(3);
  });
});
