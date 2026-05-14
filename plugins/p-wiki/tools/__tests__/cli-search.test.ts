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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-search-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
  writeFileSync(join(dir, 'docs', 'wiki', 'pages', 'concept', 'kafka.md'),
    `---\nid: kafka\ntype: concept\ntitle: Kafka\ncreated: 2026-05-01\nupdated: 2026-05-01\nstatus: active\ntags: [streaming]\nsources: []\n---\n\n# Kafka\n\nKafka handles partitioning across consumer groups.\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pwiki search', () => {
  it('returns ranked JSON', () => {
    const r = runCli(['search', 'kafka', '--format=json']);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.total).toBeGreaterThan(0);
    expect(json.results[0].path).toBe('docs/wiki/pages/concept/kafka.md');
    expect(json.results[0]).toHaveProperty('score');
    expect(json.results[0]).toHaveProperty('snippet');
  });

  it('returns total=0 with empty results array for no match', () => {
    const r = runCli(['search', 'zzznomatch', '--format=json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).total).toBe(0);
  });

  it('honors --limit', () => {
    writeFileSync(join(dir, 'docs', 'wiki', 'pages', 'concept', 'kafka2.md'),
      `---\nid: kafka2\ntype: concept\ntitle: Kafka v2\ncreated: 2026-05-01\nupdated: 2026-05-01\nstatus: active\ntags: []\nsources: []\n---\n\n# Kafka v2\n\nMore kafka content.\n`);
    const r = runCli(['search', 'kafka', '--limit=1', '--format=json']);
    expect(JSON.parse(r.stdout).results).toHaveLength(1);
  });
});
