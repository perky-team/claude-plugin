import { describe, expect, it } from 'vitest';
import { tokenize, rankDocuments } from '../lib/search.mjs';

describe('search.tokenize', () => {
  it('lowercases and splits on non-word chars', () => {
    expect(tokenize('Kafka, Partitioning!')).toEqual(['kafka', 'partitioning']);
  });
  it('drops English stopwords', () => {
    expect(tokenize('the cat and the dog')).toEqual(['cat', 'dog']);
  });
  it('drops Russian stopwords', () => {
    expect(tokenize('кафка и темы')).toEqual(['кафка', 'темы']);
  });
});

describe('search.rankDocuments', () => {
  const docs = [
    { path: 'a.md', frontmatter: { title: 'Kafka', tags: ['streaming'] }, body: 'Kafka handles partitioning and consumer groups.' },
    { path: 'b.md', frontmatter: { title: 'Redis', tags: ['cache'] }, body: 'Redis is a cache.' },
    { path: 'c.md', frontmatter: { title: 'Partitioning explained', tags: [] }, body: 'Partitioning is splitting data.' },
  ];

  it('ranks by relevance, prefers title and tag matches', () => {
    const r = rankDocuments('kafka partitioning', docs);
    expect(r[0].path).toBe('a.md');
  });

  it('returns empty for no matches', () => {
    expect(rankDocuments('nothingmatches', docs)).toEqual([]);
  });

  it('attaches a snippet around matched terms', () => {
    const r = rankDocuments('partitioning', docs);
    expect(r[0].snippet).toMatch(/partitioning/i);
  });

  it('honors limit', () => {
    const r = rankDocuments('partitioning', docs, { limit: 1 });
    expect(r).toHaveLength(1);
  });
});
