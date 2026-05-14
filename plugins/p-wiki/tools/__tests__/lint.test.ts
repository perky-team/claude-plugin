import { describe, expect, it } from 'vitest';
import { runChecks } from '../lib/lint.mjs';

const TODAY = new Date().toISOString().slice(0, 10);
const longAgo = '2025-01-01';

const validConcept = (id: string, overrides: Partial<Record<string, unknown>> = {}) => ({
  path: `docs/wiki/pages/concept/${id}.md`,
  frontmatter: {
    id, type: 'concept', title: id,
    created: TODAY, updated: TODAY,
    status: 'active', tags: [], sources: [], ...overrides,
  },
  body: `# ${id}\n\nLink: [other](./other.md)\nLink: [more](./more.md)\nLink: [yet](./yet.md)\n`,
});

const REPO_ROOT_FILES: string[] = [];

describe('lint.runChecks', () => {
  it('reports dead links', () => {
    const docs = [validConcept('foo')];
    const r = runChecks(docs, { repoRoot: '/x', existsFn: () => false });
    expect(r.errors['dead-links'].length).toBeGreaterThan(0);
  });

  it('reports frontmatter errors when fields missing', () => {
    const bad = { path: 'docs/wiki/pages/concept/x.md', frontmatter: { id: 'x', type: 'concept' }, body: '' };
    const r = runChecks([bad as any], { repoRoot: '/x', existsFn: () => true });
    expect(r.errors.frontmatter.length).toBeGreaterThan(0);
  });

  it('reports type-directory mismatch as frontmatter error', () => {
    const doc = { path: 'docs/wiki/pages/concept/x.md', frontmatter: { id: 'x', type: 'person', title: 'X', created: TODAY, updated: TODAY, status: 'active', tags: [], sources: [] }, body: '' };
    const r = runChecks([doc as any], { repoRoot: '/x', existsFn: () => true });
    expect(r.errors.frontmatter.some((e: any) => e.expected === 'concept')).toBe(true);
  });

  it('reports orphan pages', () => {
    const a = validConcept('a');
    a.body = `# a\n`; // no links from a
    const b = validConcept('b');
    b.body = `# b\n`; // no links from b
    const r = runChecks([a, b], { repoRoot: '/x', existsFn: () => true });
    expect(r.warnings['orphan-pages'].length).toBe(2);
  });

  it('reports underlinked (less than 3 outgoing) for active concept', () => {
    const a = validConcept('a');
    a.body = `# a\n[only](./b.md)\n`;
    const r = runChecks([a], { repoRoot: '/x', existsFn: () => true });
    expect(r.warnings.underlinked.length).toBeGreaterThan(0);
  });

  it('reports stale pages older than 90 days', () => {
    const stale = validConcept('s', { updated: longAgo });
    const r = runChecks([stale], { repoRoot: '/x', existsFn: () => true });
    expect(r.warnings.stale.length).toBeGreaterThan(0);
  });

  it('totals reflect counts', () => {
    const r = runChecks([validConcept('a')], { repoRoot: '/x', existsFn: () => true });
    expect(r.totals).toEqual({
      errors: Object.values(r.errors).reduce((a: number, b: any) => a + b.length, 0),
      warnings: Object.values(r.warnings).reduce((a: number, b: any) => a + b.length, 0),
    });
  });
});
