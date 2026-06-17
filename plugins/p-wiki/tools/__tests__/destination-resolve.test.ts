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

  it('resolves sources lazily (confluence source)', () => {
    writeConfig(dir, {
      primary: 'fs',
      mirrors: [],
      sources: ['conf'],
      destinations: {
        fs: { kind: 'fs' },
        conf: {
          kind: 'confluence',
          siteUrl: 'https://x.atlassian.net', spaceKey: 'ENG', spaceId: '987',
          rootPageId: '123', subParents: { concept: '1', person: '2', source: '3', query: '4' },
        },
      },
    });
    let calls = 0;
    const transport = async () => ({ status: 200, headers: {}, body: {} });
    const r = resolveDestination({ cwd: dir, transport, _spyConfluenceFactory: () => calls++ });
    expect(r!.sourceNames).toEqual(['conf']);
    expect(calls).toBe(0);               // lazy
    expect(r!.sources[0].kind).toBe('confluence');
    expect(calls).toBe(1);               // built on first access
    void r!.sources[0];
    expect(calls).toBe(1);               // cached
  });

  it('roots an fs source at its configured path', () => {
    // A second wiki on disk, outside the primary repo.
    const other = mkdtempSync(join(tmpdir(), 'pwiki-other-'));
    mkdirSync(join(other, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
    writeFileSync(
      join(other, 'docs', 'wiki', 'pages', 'concept', 'kafka.md'),
      '---\nid: kafka\ntype: concept\ntitle: Kafka\n---\n\n# Kafka\n\nbody\n',
      'utf-8',
    );
    try {
      writeConfig(dir, {
        primary: 'fs',
        mirrors: [],
        sources: ['other'],
        destinations: { fs: { kind: 'fs' }, other: { kind: 'fs', path: other } },
      });
      const r = resolveDestination({ cwd: dir });
      const page = r!.sources[0].readPage('docs/wiki/pages/concept/kafka.md');
      expect(page.frontmatter.id).toBe('kafka');
      expect(page.body).toContain('# Kafka');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
