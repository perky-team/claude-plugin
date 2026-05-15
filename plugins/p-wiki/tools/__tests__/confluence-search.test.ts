import { describe, expect, it } from 'vitest';
import { buildSearchCql, buildListCql, escapeCqlText } from '../lib/confluence/search.mjs';

describe('CQL builder', () => {
  it('escapes double quotes and backslashes in text~', () => {
    expect(escapeCqlText('foo "bar" \\baz')).toBe('foo \\"bar\\" \\\\baz');
  });

  it('build base search', () => {
    const cql = buildSearchCql({ query: 'kafka', rootPageId: '100' });
    expect(cql).toBe('text ~ "kafka" AND ancestor = 100');
  });

  it('build with type filter OR-disjunction', () => {
    const cql = buildSearchCql({ query: 'k', rootPageId: '100', types: ['concept', 'person'] });
    expect(cql).toContain('(property["pwiki-type"] = "concept" OR property["pwiki-type"] = "person")');
  });

  it('build with tags AND-intersection via labels', () => {
    const cql = buildSearchCql({ query: 'k', rootPageId: '100', tags: ['streaming', 'kafka'] });
    expect(cql).toContain('labels = "streaming"');
    expect(cql).toContain('labels = "kafka"');
  });

  it('buildListCql for pages of given types', () => {
    const cql = buildListCql({ rootPageId: '100', types: ['concept'] });
    expect(cql).toBe('ancestor = 100 AND (property["pwiki-type"] = "concept")');
  });
});
