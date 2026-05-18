import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDestination } from '../lib/destination.mjs';
import { writeConfig } from '../lib/config.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-resolve-'));
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), 'placeholder', 'utf-8');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('destination.resolveDestination', () => {
  it('defaults to FS when no .pwiki.json is present', () => {
    const r = resolveDestination({ cwd: dir });
    expect(r).not.toBeNull();
    expect(r!.primaryName).toBe('fs');
    expect(r!.primary.kind).toBe('fs');
    expect(r!.mirrorNames).toEqual([]);
    expect(r!.mirrors).toEqual([]);
  });

  it('returns null outside a wiki', () => {
    const empty = mkdtempSync(join(tmpdir(), 'pwiki-empty-'));
    try { expect(resolveDestination({ cwd: empty })).toBeNull(); }
    finally { rmSync(empty, { recursive: true, force: true }); }
  });

  it('builds primary from v3 config; mirrors lazy', () => {
    writeConfig(dir, {
      primary: 'fs',
      mirrors: ['confluence'],
      destinations: {
        fs: { kind: 'fs' },
        confluence: {
          kind: 'confluence',
          siteUrl: 'https://x.atlassian.net', spaceKey: 'ENG', spaceId: '987',
          rootPageId: '123', subParents: { concept: '1', person: '2', source: '3', query: '4' },
        },
      },
    });
    let confluenceFactoryCalls = 0;
    const transport = async () => ({ status: 200, headers: {}, body: {} });
    const r = resolveDestination({ cwd: dir, transport, _spyConfluenceFactory: () => confluenceFactoryCalls++ });
    expect(r!.primary.kind).toBe('fs');
    expect(r!.mirrorNames).toEqual(['confluence']);
    // Lazy: not built yet
    expect(confluenceFactoryCalls).toBe(0);
    // Access triggers construction
    const m = r!.mirrors[0];
    expect(m.kind).toBe('confluence');
    expect(confluenceFactoryCalls).toBe(1);
    // Second access is cached
    void r!.mirrors[0];
    expect(confluenceFactoryCalls).toBe(1);
  });
});
