import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-fs-search-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
  writeFileSync(join(dir, 'docs', 'wiki', 'pages', 'concept', 'kafka.md'),
    `---\nid: kafka\ntype: concept\ntitle: Kafka\ncreated: 2026-05-01\nupdated: 2026-05-01\nstatus: active\ntags: [streaming]\nsources: []\n---\n\n# Kafka\n\nKafka handles partitioning across consumer groups.\n`);
  writeFileSync(join(dir, 'docs', 'wiki', 'pages', 'concept', 'redis.md'),
    `---\nid: redis\ntype: concept\ntitle: Redis\ncreated: 2026-05-01\nupdated: 2026-05-01\nstatus: active\ntags: [cache]\nsources: []\n---\n\n# Redis\n\nRedis is a cache.\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fs.search', () => {
  it('finds and ranks pages', () => {
    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    const r = dest.search('kafka partitioning', {});
    expect(r.total).toBeGreaterThan(0);
    expect(r.results[0].path).toBe('docs/wiki/pages/concept/kafka.md');
  });

  it('filters by type', () => {
    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    const r = dest.search('Redis', { type: ['concept'] });
    expect(r.results.every(x => x.type === 'concept')).toBe(true);
  });

  it('honors limit', () => {
    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    const r = dest.search('kafka redis', { limit: 1 });
    expect(r.results).toHaveLength(1);
  });

  it('returns empty results for no match', () => {
    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    const r = dest.search('totallyabsent', {});
    expect(r.total).toBe(0);
    expect(r.results).toEqual([]);
  });
});
