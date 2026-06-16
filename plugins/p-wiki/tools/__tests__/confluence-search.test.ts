import { describe, expect, it } from 'vitest';
import { buildSearchCql, escapeCqlText } from '../lib/confluence/search.mjs';

describe('CQL builder', () => {
  it('escapes double quotes and backslashes in text~', () => {
    expect(escapeCqlText('foo "bar" \\baz')).toBe('foo \\"bar\\" \\\\baz');
  });

  it('build base search', () => {
    const cql = buildSearchCql({ query: 'kafka', rootPageId: '100' });
    expect(cql).toBe('text ~ "kafka" AND ancestor = 100');
  });

  it('never emits a property[...] clause (Confluence Cloud CQL rejects it)', () => {
    // Type filtering moved to in-memory post-filtering; the CQL must stay free
    // of `property[...]` or live Confluence returns HTTP 400.
    const cql = buildSearchCql({ query: 'k', rootPageId: '100', tags: ['streaming'] });
    expect(cql).not.toContain('property[');
  });

  it('build with tags AND-intersection via labels', () => {
    const cql = buildSearchCql({ query: 'k', rootPageId: '100', tags: ['streaming', 'kafka'] });
    expect(cql).toContain('labels = "streaming"');
    expect(cql).toContain('labels = "kafka"');
  });

});
