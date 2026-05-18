import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-fs-write-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'wiki', 'raw', 'pastes'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fs.writePage', () => {
  it('creates a new concept page with valid frontmatter', () => {
    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    const r = dest.writePage({
      type: 'concept',
      slug: 'foo',
      frontmatter: {
        id: 'foo', type: 'concept', title: 'Foo',
        created: '2026-05-14', updated: '2026-05-14',
        status: 'active', tags: [], sources: [],
      },
      body: '\n# Foo\n\nBody.\n',
    });
    expect(r.created).toBe(true);
    expect(r.path).toBe('docs/wiki/pages/concept/foo.md');
    expect(r.slug).toBe('foo');
    expect(r.id).toBe('foo');
    const text = readFileSync(join(dir, r.path), 'utf-8');
    expect(text).toMatch(/^---\n/);
    expect(text).toMatch(/# Foo/);
  });

  it('fails with conflict info when slug taken (default on-conflict=fail)', () => {
    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    const args = {
      type: 'concept', slug: 'foo',
      frontmatter: {
        id: 'foo', type: 'concept', title: 'Foo',
        created: '2026-05-14', updated: '2026-05-14',
        status: 'active', tags: [], sources: [],
      },
      body: '\n# Foo\n',
    };
    dest.writePage(args);
    const r = dest.writePage(args);
    expect(r.created).toBe(false);
    expect(r.existingPath).toBe('docs/wiki/pages/concept/foo.md');
    expect(r.dateSuffixSlug).toMatch(/^foo-\d{4}-\d{2}-\d{2}$/);
  });

  it('applies date-suffix when on-conflict=date-suffix', () => {
    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    const args = {
      type: 'concept', slug: 'foo',
      frontmatter: {
        id: 'foo', type: 'concept', title: 'Foo',
        created: '2026-05-14', updated: '2026-05-14',
        status: 'active', tags: [], sources: [],
      },
      body: '\n# Foo\n',
    };
    dest.writePage(args);
    const r = dest.writePage({ ...args, onConflict: 'date-suffix' });
    expect(r.created).toBe(true);
    expect(r.slug).toMatch(/^foo-\d{4}-\d{2}-\d{2}$/);
  });

  it('overwrites when on-conflict=overwrite', () => {
    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    const args = {
      type: 'concept', slug: 'foo',
      frontmatter: {
        id: 'foo', type: 'concept', title: 'Foo',
        created: '2026-05-14', updated: '2026-05-14',
        status: 'active', tags: [], sources: [],
      },
      body: '\n# v1\n',
    };
    dest.writePage(args);
    const r = dest.writePage({ ...args, body: '\n# v2\n', onConflict: 'overwrite' });
    expect(r.created).toBe(true);
    const text = readFileSync(join(dir, r.path), 'utf-8');
    expect(text).toContain('# v2');
  });

  it('writes raw-paste under raw/pastes/', () => {
    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    const r = dest.writePage({
      type: 'raw-paste', slug: '2026-05-14-note',
      frontmatter: {
        id: '2026-05-14-note', type: 'raw-paste', title: 'Note',
        'source-url': null, 'source-type': 'doc', ingested: '2026-05-14',
        compiled: false, 'compiled-to': [],
      },
      body: '\n# Note\n\nPaste body.\n',
    });
    expect(r.path).toBe('docs/wiki/raw/pastes/2026-05-14-note.md');
  });
});
