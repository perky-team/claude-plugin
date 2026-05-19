import { describe, expect, it, vi } from 'vitest';
import { rewriteCrossLinks, stripCrossLinks } from '../lib/cross-links.mjs';

function mockSrc(parseMap: Record<string, any>) {
  return {
    parseWikiLink: (href: string) => parseMap[href] ?? null,
  } as any;
}

function mockDst(formatMap: Record<string, string>, opts?: { throwOn?: string }) {
  return {
    formatWikiLink: (id: { type: string; slug: string }) => {
      const k = `${id.type}/${id.slug}`;
      if (opts?.throwOn === k) throw new Error('miss');
      return formatMap[k] ?? `?/${k}`;
    },
  } as any;
}

describe('rewriteCrossLinks', () => {
  it('rewrites wiki links and passes externals verbatim', () => {
    const body = `Hello [Bar](./bar.md), see also [Google](https://google.com) and [Baz](../source/baz.md).`;
    const src = mockSrc({ './bar.md': { type: 'concept', slug: 'bar' }, '../source/baz.md': { type: 'source', slug: 'baz' } });
    const dst = mockDst({ 'concept/bar': 'bar.md', 'source/baz': '../source/baz.md' });
    const out = rewriteCrossLinks(body, src, 'docs/wiki/pages/concept/foo.md', dst, 'docs/wiki/pages/concept/foo.md');
    expect(out).toBe(`Hello [Bar](bar.md), see also [Google](https://google.com) and [Baz](../source/baz.md).`);
  });

  it('skips links inside fenced code blocks', () => {
    const body = "Real [Bar](./bar.md).\n\n```\n[Bar](./bar.md)\n```\n";
    const src = mockSrc({ './bar.md': { type: 'concept', slug: 'bar' } });
    const dst = mockDst({ 'concept/bar': 'OK' });
    const out = rewriteCrossLinks(body, src, 'p.md', dst, 'p.md');
    expect(out).toBe("Real [Bar](OK).\n\n```\n[Bar](./bar.md)\n```\n");
  });

  it('skips links inside inline code', () => {
    const body = "Real [Bar](./bar.md) and `[Bar](./bar.md)`.";
    const src = mockSrc({ './bar.md': { type: 'concept', slug: 'bar' } });
    const dst = mockDst({ 'concept/bar': 'OK' });
    const out = rewriteCrossLinks(body, src, 'p.md', dst, 'p.md');
    expect(out).toBe("Real [Bar](OK) and `[Bar](./bar.md)`.");
  });

  it('emits verbatim and warns when formatWikiLink throws', () => {
    const body = `[Broken](./broken.md)`;
    const src = mockSrc({ './broken.md': { type: 'concept', slug: 'broken' } });
    const dst = mockDst({}, { throwOn: 'concept/broken' });
    const warn = vi.fn();
    const out = rewriteCrossLinks(body, src, 'p.md', dst, 'p.md', { onWarn: warn });
    expect(out).toBe(`[Broken](./broken.md)`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ type: 'concept', slug: 'broken' });
  });
});

describe('stripCrossLinks', () => {
  it('replaces wiki link hrefs with sentinel, preserves externals', () => {
    const body = `[Bar](./bar.md), [Google](https://google.com), [Baz](../source/baz.md)`;
    const src = mockSrc({ './bar.md': { type: 'concept', slug: 'bar' }, '../source/baz.md': { type: 'source', slug: 'baz' } });
    const out = stripCrossLinks(body, src, 'docs/wiki/pages/concept/foo.md');
    expect(out).toBe(`[Bar](#pwiki-pending), [Google](https://google.com), [Baz](#pwiki-pending)`);
  });

  it('skips code blocks', () => {
    const body = "[Bar](./bar.md)\n\n```\n[Bar](./bar.md)\n```\n";
    const src = mockSrc({ './bar.md': { type: 'concept', slug: 'bar' } });
    const out = stripCrossLinks(body, src, 'p.md');
    expect(out).toBe("[Bar](#pwiki-pending)\n\n```\n[Bar](./bar.md)\n```\n");
  });
});
