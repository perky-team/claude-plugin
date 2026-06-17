import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-fs-lint-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
  writeFileSync(join(dir, 'docs', 'wiki', 'pages', 'concept', 'a.md'),
    `---\nid: a\ntype: concept\ntitle: A\ncreated: 2026-05-01\nupdated: 2026-05-01\nstatus: active\ntags: []\nsources: []\n---\n\n# A\n[gone](./missing.md)\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fs.lint', () => {
  it('reports the dead link', () => {
    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    const r = dest.lint({});
    expect(r.errors['dead-links']).toHaveLength(1);
    expect(r.totals.errors).toBeGreaterThanOrEqual(1);
  });

  it('reports an unparseable file as a frontmatter error (not silently dropped)', () => {
    // Write a malformed file — no YAML frontmatter delimiters, so parseFrontmatter will produce
    // empty/undefined fields that fail schema validation, simulating a broken file.
    writeFileSync(join(dir, 'docs', 'wiki', 'pages', 'concept', 'broken.md'),
      'not valid frontmatter at all\njust raw text\n');
    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    const r = dest.lint({});
    // The broken page must appear as a frontmatter error (not silently skipped)
    const brokenEntry = r.errors['frontmatter'].find(
      (e: any) => (e.file ?? '').includes('broken'));
    expect(brokenEntry).toBeDefined();
  });

  it('flags source-changed when a tracked source was committed after the page', () => {
    // Fresh git repo so sourceDate() (git log -1 --format=%cs) resolves.
    const git = (...a: string[]) =>
      execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
    git('init', '-q');
    git('config', 'user.email', 't@t.test');
    git('config', 'user.name', 'T');

    // Source committed on a fixed date, newer than the page's `updated`.
    mkdirSync(join(dir, 'docs', 'specs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'specs', 's.md'), '# Source\n');
    git('add', 'docs/specs/s.md');
    execFileSync('git', ['commit', '-q', '-m', 'add source'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-06-05T00:00:00', GIT_COMMITTER_DATE: '2026-06-05T00:00:00' },
    });

    // Page derived from that source, last (re)compiled before the source change.
    writeFileSync(join(dir, 'docs', 'wiki', 'pages', 'concept', 'derived.md'),
      `---\nid: derived\ntype: concept\ntitle: Derived\ncreated: 2026-05-01\nupdated: 2026-05-01\nstatus: active\ntags: []\nsources:\n  - docs/specs/s.md\n---\n\n# Derived\n[a](./a.md)\n`);

    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    const r = dest.lint({});
    const sc = r.warnings['source-changed'];
    expect(sc).toHaveLength(1);
    expect(sc[0]).toMatchObject({
      file: 'docs/wiki/pages/concept/derived.md',
      source: 'docs/specs/s.md',
      sourceDate: '2026-06-05',
      pageUpdated: '2026-05-01',
    });
  });
});
