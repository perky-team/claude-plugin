import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pwiki.mjs');

let dir: string;
function runCli(args: string[]) {
  return spawnSync('node', [cli, ...args], { cwd: dir, encoding: 'utf-8' });
}

function writePage(rel: string, frontmatter: Record<string, unknown>, body: string) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const fm = Object.entries(frontmatter).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.map(x => JSON.stringify(x)).join(', ')}]`;
    if (typeof v === 'string') return `${k}: ${v}`;
    return `${k}: ${JSON.stringify(v)}`;
  }).join('\n');
  writeFileSync(abs, `---\n${fm}\n---\n${body}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-cli-backlinks-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pwiki backlinks', () => {
  it('exit 0 with inserted list on success', () => {
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

    const r = runCli(['backlinks', 'docs/wiki/pages/concept/kafka.md', '--format=json']);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.target).toBe('docs/wiki/pages/concept/kafka.md');
    expect(json.title).toBe('Kafka');
    expect(json.total).toBe(1);
    expect(json.inserted).toHaveLength(1);
  });

  it('exit 2 with candidates when count exceeds threshold', () => {
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
    const r = runCli(['backlinks', 'docs/wiki/pages/concept/plan.md', '--max-suggestions=3', '--format=json']);
    expect(r.status).toBe(2);
    const json = JSON.parse(r.stdout);
    expect(json.suspicious).toBe(true);
    expect(json.total).toBe(5);
    expect(json.candidates).toHaveLength(5);
  });

  it('exit 0 with all inserted when --force overrides threshold', () => {
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
    const r = runCli(['backlinks', 'docs/wiki/pages/concept/plan.md', '--max-suggestions=3', '--force', '--format=json']);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.total).toBe(5);
  });

  it('exit 1 when target path missing', () => {
    const r = runCli(['backlinks', '--format=json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/path.*required/i);
  });

  it('exit 1 when target unreadable', () => {
    const r = runCli(['backlinks', 'docs/wiki/pages/concept/nonexistent.md', '--format=json']);
    expect(r.status).toBe(1);
  });

  it('exit 1 when run outside a p-wiki repo', () => {
    const orphan = mkdtempSync(join(tmpdir(), 'pwiki-cli-orphan-'));
    const r = spawnSync('node', [cli, 'backlinks', 'x.md', '--format=json'],
      { cwd: orphan, encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not inside a p-wiki repo/i);
    rmSync(orphan, { recursive: true, force: true });
  });
});
