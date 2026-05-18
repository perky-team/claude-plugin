import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';

let dir: string;
let dest: any;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-fs-links-'));
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
  dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('FS parseWikiLink / formatWikiLink', () => {
  const from = 'docs/wiki/pages/concept/foo.md';

  it('parses sibling .md as concept/<slug>', () => {
    expect(dest.parseWikiLink('./bar.md', from)).toEqual({ type: 'concept', slug: 'bar' });
    expect(dest.parseWikiLink('bar.md', from)).toEqual({ type: 'concept', slug: 'bar' });
  });

  it('parses parent traversal across types', () => {
    expect(dest.parseWikiLink('../source/baz.md', from)).toEqual({ type: 'source', slug: 'baz' });
    expect(dest.parseWikiLink('../queries/2026-05-18-q.md', from)).toEqual({ type: 'query', slug: '2026-05-18-q' });
  });

  it('returns null for external URLs, anchors, mailto', () => {
    expect(dest.parseWikiLink('https://example.com', from)).toBeNull();
    expect(dest.parseWikiLink('mailto:x@y.z', from)).toBeNull();
    expect(dest.parseWikiLink('#section', from)).toBeNull();
  });

  it('returns null for paths outside the pages tree', () => {
    expect(dest.parseWikiLink('../../raw/x.md', from)).toBeNull();
    expect(dest.parseWikiLink('../../README.md', from)).toBeNull();
  });

  it('formats a sibling link relative to the source page', () => {
    expect(dest.formatWikiLink({ type: 'concept', slug: 'bar' }, from)).toBe('bar.md');
    expect(dest.formatWikiLink({ type: 'source', slug: 'baz' }, from)).toBe('../source/baz.md');
  });
});
