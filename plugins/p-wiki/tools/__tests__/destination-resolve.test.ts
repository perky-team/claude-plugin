import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDestination } from '../lib/destination.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-resolve-'));
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('destination.resolveDestination', () => {
  it('returns an FS destination when wiki marker is present', () => {
    const dest = resolveDestination({ cwd: dir });
    expect(dest.kind).toBe('fs');
    expect(dest.rootPath).toBe(dir);
  });

  it('returns null when no wiki marker is found', () => {
    const empty = mkdtempSync(join(tmpdir(), 'pwiki-none-'));
    expect(resolveDestination({ cwd: empty })).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });

  it('exposes the full interface surface', () => {
    const dest = resolveDestination({ cwd: dir });
    for (const m of ['pageExists', 'readPage', 'writePage', 'mutatePage', 'movePage', 'listPages', 'search', 'lint']) {
      expect(typeof dest[m]).toBe('function');
    }
  });
});
