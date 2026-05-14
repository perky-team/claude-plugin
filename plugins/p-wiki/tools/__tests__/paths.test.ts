import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findWikiRoot, toRepoRelative } from '../lib/paths.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-paths-'));
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('paths.findWikiRoot', () => {
  it('finds the repo root when cwd is the repo root', () => {
    expect(findWikiRoot(dir)).toBe(dir);
  });

  it('finds the repo root from a nested cwd', () => {
    const nested = join(dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findWikiRoot(nested)).toBe(dir);
  });

  it('returns null when no wiki marker is present', () => {
    const nowhere = mkdtempSync(join(tmpdir(), 'pwiki-empty-'));
    expect(findWikiRoot(nowhere)).toBeNull();
    rmSync(nowhere, { recursive: true, force: true });
  });
});

describe('paths.toRepoRelative', () => {
  it('returns POSIX repo-relative path even on Windows-style inputs', () => {
    const abs = join(dir, 'docs', 'wiki', 'pages', 'concept', 'foo.md');
    expect(toRepoRelative(dir, abs)).toBe('docs/wiki/pages/concept/foo.md');
  });
});
