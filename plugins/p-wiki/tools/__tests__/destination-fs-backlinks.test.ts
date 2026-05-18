import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsDestination } from '../lib/destinations/fs.mjs';

let dir: string;

function writePage(rel: string, frontmatter: Record<string, unknown>, body: string) {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  const fm = Object.entries(frontmatter).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.map(x => JSON.stringify(x)).join(', ')}]`;
    if (typeof v === 'string') return `${k}: ${v}`;
    return `${k}: ${JSON.stringify(v)}`;
  }).join('\n');
  writeFileSync(abs, `---\n${fm}\n---\n${body}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-fs-backlinks-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'source'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fs.applyBacklinks', () => {
  it('returns 0 insertions when no other pages mention the title', () => {
    writePage('docs/wiki/pages/concept/kafka.md', {
      id: 'kafka', type: 'concept', title: 'Kafka',
      created: '2026-05-15', updated: '2026-05-15',
      status: 'active', tags: [], sources: [],
    }, '\n# Kafka\n\nAbout Kafka.\n');

    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    const r = dest.applyBacklinks({ targetPath: 'docs/wiki/pages/concept/kafka.md' });
    expect(r.total).toBe(0);
    expect(r.inserted).toEqual([]);
    expect(r.suspicious).toBeUndefined();
  });

  it('inserts a link into a sibling page that mentions the title', () => {
    writePage('docs/wiki/pages/concept/kafka.md', {
      id: 'kafka', type: 'concept', title: 'Kafka',
      created: '2026-05-15', updated: '2026-05-15',
      status: 'active', tags: [], sources: [],
    }, '\n# Kafka\n\nAbout Kafka.\n');
    writePage('docs/wiki/pages/concept/streaming.md', {
      id: 'streaming', type: 'concept', title: 'Streaming',
      created: '2026-05-15', updated: '2026-05-15',
      status: 'active', tags: [], sources: [],
    }, '\n# Streaming\n\nWe use Kafka here.\n');

    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    const r = dest.applyBacklinks({ targetPath: 'docs/wiki/pages/concept/kafka.md' });
    expect(r.total).toBe(1);
    expect(r.inserted).toEqual([
      { file: 'docs/wiki/pages/concept/streaming.md', line: 4 },
    ]);

    const updated = readFileSync(join(dir, 'docs/wiki/pages/concept/streaming.md'), 'utf-8');
    expect(updated).toContain('We use [Kafka](kafka.md) here.');
  });

  it('uses a relative path across directories', () => {
    writePage('docs/wiki/pages/concept/kafka.md', {
      id: 'kafka', type: 'concept', title: 'Kafka',
      created: '2026-05-15', updated: '2026-05-15',
      status: 'active', tags: [], sources: [],
    }, '\n# Kafka\n');
    writePage('docs/wiki/pages/source/article-x-summary.md', {
      id: 'article-x-summary', type: 'source', title: 'Article X',
      created: '2026-05-15', updated: '2026-05-15',
      status: 'active', tags: [], sources: [],
      'source-url': 'https://x', 'source-type': 'article',
    }, '\n# Summary\n\nDiscusses Kafka briefly.\n');

    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    dest.applyBacklinks({ targetPath: 'docs/wiki/pages/concept/kafka.md' });
    const updated = readFileSync(join(dir, 'docs/wiki/pages/source/article-x-summary.md'), 'utf-8');
    expect(updated).toContain('Discusses [Kafka](../concept/kafka.md) briefly.');
  });

  it('skips the target page itself (skip-self)', () => {
    writePage('docs/wiki/pages/concept/kafka.md', {
      id: 'kafka', type: 'concept', title: 'Kafka',
      created: '2026-05-15', updated: '2026-05-15',
      status: 'active', tags: [], sources: [],
    }, '\n# Kafka\n\nKafka is a thing. Kafka.\n');

    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    const r = dest.applyBacklinks({ targetPath: 'docs/wiki/pages/concept/kafka.md' });
    expect(r.total).toBe(0);
    const text = readFileSync(join(dir, 'docs/wiki/pages/concept/kafka.md'), 'utf-8');
    expect(text).not.toContain('[Kafka]');
  });

  it('is idempotent — re-run inserts nothing', () => {
    writePage('docs/wiki/pages/concept/kafka.md', {
      id: 'kafka', type: 'concept', title: 'Kafka',
      created: '2026-05-15', updated: '2026-05-15',
      status: 'active', tags: [], sources: [],
    }, '\n# Kafka\n');
    writePage('docs/wiki/pages/concept/streaming.md', {
      id: 'streaming', type: 'concept', title: 'Streaming',
      created: '2026-05-15', updated: '2026-05-15',
      status: 'active', tags: [], sources: [],
    }, '\n# Streaming\n\nWe use Kafka here.\n');

    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    dest.applyBacklinks({ targetPath: 'docs/wiki/pages/concept/kafka.md' });
    const r2 = dest.applyBacklinks({ targetPath: 'docs/wiki/pages/concept/kafka.md' });
    expect(r2.total).toBe(0);
  });

  it('returns suspicious shape and writes nothing when count exceeds threshold', () => {
    writePage('docs/wiki/pages/concept/plan.md', {
      id: 'plan', type: 'concept', title: 'Plan',
      created: '2026-05-15', updated: '2026-05-15',
      status: 'active', tags: [], sources: [],
    }, '\n# Plan\n');
    // Create 5 pages each mentioning "Plan"
    for (let i = 0; i < 5; i++) {
      writePage(`docs/wiki/pages/concept/p${i}.md`, {
        id: `p${i}`, type: 'concept', title: `P${i}`,
        created: '2026-05-15', updated: '2026-05-15',
        status: 'active', tags: [], sources: [],
      }, `\n# P${i}\n\nWe Plan to do something.\n`);
    }

    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    const r = dest.applyBacklinks({ targetPath: 'docs/wiki/pages/concept/plan.md', maxSuggestions: 3 });
    expect(r.suspicious).toBe(true);
    expect(r.total).toBe(5);
    expect(r.candidates).toHaveLength(5);
    expect(r.candidates[0]).toHaveProperty('file');
    expect(r.candidates[0]).toHaveProperty('line');
    expect(r.candidates[0]).toHaveProperty('preview');

    // No file should have been modified.
    for (let i = 0; i < 5; i++) {
      const text = readFileSync(join(dir, `docs/wiki/pages/concept/p${i}.md`), 'utf-8');
      expect(text).not.toContain('[Plan](');
    }
  });

  it('inserts everything when force=true above the threshold', () => {
    writePage('docs/wiki/pages/concept/plan.md', {
      id: 'plan', type: 'concept', title: 'Plan',
      created: '2026-05-15', updated: '2026-05-15',
      status: 'active', tags: [], sources: [],
    }, '\n# Plan\n');
    for (let i = 0; i < 5; i++) {
      writePage(`docs/wiki/pages/concept/p${i}.md`, {
        id: `p${i}`, type: 'concept', title: `P${i}`,
        created: '2026-05-15', updated: '2026-05-15',
        status: 'active', tags: [], sources: [],
      }, `\n# P${i}\n\nWe Plan to do something.\n`);
    }

    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    const r = dest.applyBacklinks({ targetPath: 'docs/wiki/pages/concept/plan.md', maxSuggestions: 3, force: true });
    expect(r.suspicious).toBeUndefined();
    expect(r.total).toBe(5);
    expect(r.inserted).toHaveLength(5);
  });

  it('throws when target has no title in frontmatter', () => {
    writePage('docs/wiki/pages/concept/notitle.md', {
      id: 'notitle', type: 'concept', title: '   ',
      created: '2026-05-15', updated: '2026-05-15',
      status: 'active', tags: [], sources: [],
    }, '\n# X\n');
    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    expect(() => dest.applyBacklinks({ targetPath: 'docs/wiki/pages/concept/notitle.md' }))
      .toThrow(/title/i);
  });

  it('does not bump updated: in any modified file', () => {
    writePage('docs/wiki/pages/concept/kafka.md', {
      id: 'kafka', type: 'concept', title: 'Kafka',
      created: '2026-05-15', updated: '2026-05-15',
      status: 'active', tags: [], sources: [],
    }, '\n# Kafka\n');
    writePage('docs/wiki/pages/concept/streaming.md', {
      id: 'streaming', type: 'concept', title: 'Streaming',
      created: '2026-05-15', updated: '2020-01-01',  // ancient
      status: 'active', tags: [], sources: [],
    }, '\n# Streaming\n\nWe use Kafka here.\n');

    const dest = createFsDestination({ root: dir, destinationConfig: { kind: 'fs' } });
    dest.applyBacklinks({ targetPath: 'docs/wiki/pages/concept/kafka.md' });
    const text = readFileSync(join(dir, 'docs/wiki/pages/concept/streaming.md'), 'utf-8');
    expect(text).toContain('updated: 2020-01-01');
  });
});
