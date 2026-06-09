import { describe, expect, it } from 'vitest';
import { TYPES, validateFrontmatter, templateBody, requiredFields, allowedFields } from '../lib/schema.mjs';

describe('schema.TYPES', () => {
  it('covers all seven page types', () => {
    expect(TYPES).toEqual([
      'concept', 'person', 'source', 'query',
      'raw-article', 'raw-file', 'raw-paste',
    ]);
  });
});

describe('schema.validateFrontmatter', () => {
  it('accepts a complete concept frontmatter', () => {
    const fm = {
      id: 'kafka', type: 'concept', title: 'Kafka',
      created: '2026-05-14', updated: '2026-05-14',
      status: 'active', tags: [], sources: [],
    };
    expect(validateFrontmatter(fm)).toEqual({ ok: true });
  });

  it('rejects missing required field', () => {
    const fm = { id: 'k', type: 'concept', title: 'K', created: '2026-05-14' };
    const r = validateFrontmatter(fm);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing required field/i);
  });

  it('rejects type-directory mismatch handled separately (not here)', () => {
    // schema validates frontmatter shape only; type<->directory is a lint concern
    const fm = {
      id: 'k', type: 'concept', title: 'K',
      created: '2026-05-14', updated: '2026-05-14',
      status: 'active', tags: [], sources: [],
    };
    expect(validateFrontmatter(fm).ok).toBe(true);
  });

  it('rejects unknown type', () => {
    const fm = { id: 'x', type: 'gibberish', title: 'x' };
    const r = validateFrontmatter(fm);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown type/i);
  });

  it('rejects raw-paste with non-doc source-type', () => {
    const fm = {
      id: 'p', type: 'raw-paste', title: 'P',
      'source-url': null, 'source-type': 'article',
      ingested: '2026-05-14', compiled: false, 'compiled-to': [],
    };
    const r = validateFrontmatter(fm);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/raw-paste.*source-type/i);
  });

  it('accepts a valid conflict-since', () => {
    const fm = {
      id: 'k', type: 'concept', title: 'K',
      created: '2026-05-14', updated: '2026-05-14',
      status: 'active', tags: [], sources: [],
      'conflict-since': '2026-06-05',
    };
    expect(validateFrontmatter(fm)).toEqual({ ok: true });
  });

  it('rejects a malformed conflict-since', () => {
    const fm = {
      id: 'k', type: 'concept', title: 'K',
      created: '2026-05-14', updated: '2026-05-14',
      status: 'active', tags: [], sources: [],
      'conflict-since': 'June 5',
    };
    const r = validateFrontmatter(fm);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/conflict-since/i);
  });
});

describe('schema.allowedFields', () => {
  it('lists conflict-since as allowed on concept/person/source/query', () => {
    for (const t of ['concept', 'person', 'source', 'query']) {
      expect(allowedFields(t)).toContain('conflict-since');
    }
  });

  it('does not list conflict-since as allowed on raw types', () => {
    expect(allowedFields('raw-article')).not.toContain('conflict-since');
  });
});

describe('schema.templateBody', () => {
  it('returns a markdown stub for concept', () => {
    expect(templateBody('concept', { title: 'Foo' })).toMatch(/# Foo/);
    expect(templateBody('concept', { title: 'Foo' })).toMatch(/## Key facts/);
  });

  it('returns a query stub including the question', () => {
    expect(templateBody('query', { title: 'Q', question: 'What is X?' })).toMatch(/What is X\?/);
  });
});

describe('schema.requiredFields', () => {
  it('lists required fields for query type', () => {
    expect(requiredFields('query')).toContain('question');
    expect(requiredFields('query')).toContain('informed-by');
    expect(requiredFields('query')).not.toContain('sources');
  });
});
