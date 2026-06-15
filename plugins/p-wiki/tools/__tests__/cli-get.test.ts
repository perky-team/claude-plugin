import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pwiki.mjs');

let dir: string;
function runCli(args: string[]) {
  return spawnSync('node', [cli, ...args], { cwd: dir, encoding: 'utf-8' });
}

const PAGE =
  `---\nid: kafka\ntype: concept\ntitle: Kafka\ncreated: 2026-05-01\nupdated: 2026-05-01\nstatus: active\ntags: [streaming]\nsources: []\n---\n\n# Kafka\n\nKafka handles partitioning across consumer groups.\n`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-get-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
  writeFileSync(join(dir, 'docs', 'wiki', 'pages', 'concept', 'kafka.md'), PAGE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pwiki get (FS)', () => {
  it('prints reconstructed markdown (frontmatter fence + body) by default', () => {
    const r = runCli(['get', 'docs/wiki/pages/concept/kafka.md']);
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith('---\n')).toBe(true);
    expect(r.stdout).toContain('id: kafka');
    expect(r.stdout).toContain('# Kafka');
    expect(r.stdout).toContain('Kafka handles partitioning across consumer groups.');
  });

  it('--format=json returns { path, frontmatter, body }', () => {
    const r = runCli(['get', 'docs/wiki/pages/concept/kafka.md', '--format=json']);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.path).toBe('docs/wiki/pages/concept/kafka.md');
    expect(json.frontmatter.id).toBe('kafka');
    expect(json.frontmatter.title).toBe('Kafka');
    expect(json.frontmatter.tags).toEqual(['streaming']);
    expect(json.body).toContain('# Kafka');
  });

  it('missing page → exit 1 with error.code page-not-found', () => {
    const r = runCli(['get', 'docs/wiki/pages/concept/ghost.md', '--format=json']);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe('page-not-found');
  });

  it('unknown --format is treated as text', () => {
    const r = runCli(['get', 'docs/wiki/pages/concept/kafka.md', '--format=xml']);
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith('---\n')).toBe(true);
    expect(r.stdout).toContain('# Kafka');
  });

  it('no path argument → exit 1', () => {
    const r = runCli(['get']);
    expect(r.status).toBe(1);
  });

  it('not inside a p-wiki repo → exit 1', () => {
    const outside = mkdtempSync(join(tmpdir(), 'pwiki-get-outside-'));
    try {
      const r = spawnSync('node', [cli, 'get', 'docs/wiki/pages/concept/kafka.md'], { cwd: outside, encoding: 'utf-8' });
      expect(r.status).toBe(1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
