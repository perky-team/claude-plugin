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

  it('does not flag raw/ pages as orphans', () => {
    // Raw pages are never linked from body — they appear only in `sources:` frontmatter.
    // Including them in orphan-pages would generate a noisy warning for every raw ingest.
    const raw = {
      path: 'docs/wiki/raw/articles/foo.md',
      frontmatter: {
        id: 'foo', type: 'raw-article', title: 'Foo',
        'source-url': 'https://x.test', 'source-type': 'article',
        ingested: TODAY, compiled: false, 'compiled-to': [],
      },
      body: '# Foo\n',
    };
    const r = runChecks([raw as any], { repoRoot: '/x', existsFn: () => true });
    expect(r.warnings['orphan-pages']).toEqual([]);
  });

  it('totals reflect counts', () => {
    const r = runChecks([validConcept('a')], { repoRoot: '/x', existsFn: () => true });
    expect(r.totals).toEqual({
      errors: Object.values(r.errors).reduce((a: number, b: any) => a + b.length, 0),
      warnings: Object.values(r.warnings).reduce((a: number, b: any) => a + b.length, 0),
    });
  });

  it('flags a page with conflict-since', () => {
    const c = validConcept('a', { 'conflict-since': '2026-06-05' });
    const r = runChecks([c], { repoRoot: '/x', existsFn: () => true });
    expect(r.warnings.conflicts).toHaveLength(1);
    expect(r.warnings.conflicts[0]).toMatchObject({ file: c.path, since: '2026-06-05' });
  });

  it('does not flag a page without conflict-since', () => {
    const r = runChecks([validConcept('a')], { repoRoot: '/x', existsFn: () => true });
    expect(r.warnings.conflicts).toEqual([]);
  });

  it('flags an unflagged legacy body callout (pricing-engine shape)', () => {
    const c = validConcept('a');
    c.body = `# A\n\n> ⚠️ Partially superseded (2026-06-05): old model replaced. See [x](./x.md).\n\nbody\n[a](./b.md)\n`;
    const r = runChecks([c], { repoRoot: '/x', existsFn: () => true });
    expect(r.warnings.conflicts).toHaveLength(1);
    expect(r.warnings.conflicts[0]).toMatchObject({ file: c.path, since: '2026-06-05' });
  });

  it('flags a body conflict callout with no parseable date (since: null)', () => {
    const c = validConcept('a');
    c.body = `# A\n\n> ⚠️ Conflict: source X disagrees with source Y.\n\n[a](./b.md)\n`;
    const r = runChecks([c], { repoRoot: '/x', existsFn: () => true });
    expect(r.warnings.conflicts).toHaveLength(1);
    expect(r.warnings.conflicts[0].since).toBeNull();
  });

  it('prefers the frontmatter conflict-since over the marker date', () => {
    const c = validConcept('a', { 'conflict-since': '2026-06-01' });
    c.body = `# A\n\n> ⚠️ Conflict (since 2026-06-05): ...\n\n[a](./b.md)\n`;
    const r = runChecks([c], { repoRoot: '/x', existsFn: () => true });
    expect(r.warnings.conflicts[0].since).toBe('2026-06-01');
  });

  it('flags a non-⚠️ "**Superseded (date):**" callout', () => {
    const c = validConcept('a');
    c.body = `# A\n\n> **Superseded (2026-05-27):** replaced. See [x](./x.md).\n\n[a](./b.md)\n`;
    const r = runChecks([c], { repoRoot: '/x', existsFn: () => true });
    expect(r.warnings.conflicts).toHaveLength(1);
    expect(r.warnings.conflicts[0].since).toBe('2026-05-27');
  });

  it('flags a "> **Note:** ... superseded ..." callout', () => {
    const c = validConcept('a');
    c.body = `# A\n\n> **Note:** this ADR has been superseded in two parts.\n\n[a](./b.md)\n`;
    const r = runChecks([c], { repoRoot: '/x', existsFn: () => true });
    expect(r.warnings.conflicts).toHaveLength(1);
  });

  it('does NOT flag a conflict callout on an ADR/decision page (immutable record)', () => {
    const c = validConcept('adr-0018-synthetic-depth-ladder');
    c.body = `# ADR-0018\n\n> **Superseded (2026-05-27):** not implemented in v1.\n\n[a](./b.md)\n`;
    const r = runChecks([c], { repoRoot: '/x', existsFn: () => true });
    expect(r.warnings.conflicts).toEqual([]);
  });

  it('does not flag prose mentioning superseded outside a blockquote', () => {
    const c = validConcept('a');
    c.body = `# A\n\nThis mechanism was superseded last year.\n\n[a](./b.md)\n`;
    const r = runChecks([c], { repoRoot: '/x', existsFn: () => true });
    expect(r.warnings.conflicts).toEqual([]);
  });

  it('flags a page whose source is newer than its updated date', () => {
    const c = validConcept('a', { updated: '2026-05-12', sources: ['docs/specs/s.md'] });
    const sourceDateFn = (p: string) => (p === 'docs/specs/s.md' ? '2026-06-05' : null);
    const r = runChecks([c], { repoRoot: '/x', existsFn: () => true, sourceDateFn });
    expect(r.warnings['source-changed']).toHaveLength(1);
    expect(r.warnings['source-changed'][0]).toMatchObject({
      file: c.path, source: 'docs/specs/s.md', sourceDate: '2026-06-05', pageUpdated: '2026-05-12',
    });
  });

  it('does not flag source-changed when the source predates updated', () => {
    const c = validConcept('a', { updated: '2026-06-05', sources: ['docs/specs/s.md'] });
    const sourceDateFn = () => '2026-05-12';
    const r = runChecks([c], { repoRoot: '/x', existsFn: () => true, sourceDateFn });
    expect(r.warnings['source-changed']).toEqual([]);
  });

  it('skips source-changed when sourceDateFn is absent', () => {
    const c = validConcept('a', { updated: '2026-05-12', sources: ['docs/specs/s.md'] });
    const r = runChecks([c], { repoRoot: '/x', existsFn: () => true });
    expect(r.warnings['source-changed']).toEqual([]);
  });

  it('does not flag source-changed for a CHANGELOG source', () => {
    const c = validConcept('a', { updated: '2026-05-12', sources: ['docs/CHANGELOG.md'] });
    const r = runChecks([c], { repoRoot: '/x', existsFn: () => true, sourceDateFn: () => '2026-06-09' });
    expect(r.warnings['source-changed']).toEqual([]);
    expect(r.suppressed['source-changed'].count).toBe(1);
    expect(r.suppressed['source-changed'].sources).toContain('docs/CHANGELOG.md');
  });

  it('does not flag source-changed for a glossary source (NN- prefix)', () => {
    const c = validConcept('a', { updated: '2026-05-12', sources: ['docs/specs/00-glossary.md'] });
    const r = runChecks([c], { repoRoot: '/x', existsFn: () => true, sourceDateFn: () => '2026-06-09' });
    expect(r.warnings['source-changed']).toEqual([]);
    expect(r.suppressed['source-changed'].count).toBe(1);
  });

  it('still flags source-changed for a normal spec source', () => {
    const c = validConcept('a', { updated: '2026-05-12', sources: ['docs/specs/03-configuration.md'] });
    const r = runChecks([c], { repoRoot: '/x', existsFn: () => true, sourceDateFn: () => '2026-06-09' });
    expect(r.warnings['source-changed']).toHaveLength(1);
    expect(r.suppressed['source-changed'].count).toBe(0);
  });

  it('reports suppressed source-changed without affecting totals', () => {
    const c = validConcept('a', { updated: '2026-05-12', sources: ['docs/CHANGELOG.md'] });
    const r = runChecks([c], { repoRoot: '/x', existsFn: () => true, sourceDateFn: () => '2026-06-09' });
    expect(r.totals.warnings).toBe(
      Object.values(r.warnings).reduce((n: number, b: any) => n + b.length, 0));
  });
});
