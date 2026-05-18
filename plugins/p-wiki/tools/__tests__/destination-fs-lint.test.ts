import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
});
