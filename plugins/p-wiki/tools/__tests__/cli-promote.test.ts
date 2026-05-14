import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
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
  dir = mkdtempSync(join(tmpdir(), 'pwiki-promote-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'queries'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
  // concept page used as informed-by
  writeFileSync(join(dir, 'docs', 'wiki', 'pages', 'concept', 'kafka.md'),
    `---\nid: kafka\ntype: concept\ntitle: Kafka\ncreated: 2026-05-01\nupdated: 2026-05-01\nstatus: active\ntags: []\nsources:\n  - raw/articles/kafka-intro.md\n---\n\n# Kafka\n`);
  // query page to promote
  writeFileSync(join(dir, 'docs', 'wiki', 'pages', 'queries', '2026-05-14-what-is-kafka.md'),
    `---\nid: 2026-05-14-what-is-kafka\ntype: query\ntitle: What is Kafka\ncreated: 2026-05-14\nstatus: filed\ntags: []\nquestion: "What is Kafka?"\ninformed-by:\n  - pages/concept/kafka.md\n---\n\n# What is Kafka\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pwiki promote', () => {
  it('moves query → concept and transforms frontmatter', () => {
    const r = runCli(['promote', 'docs/wiki/pages/queries/2026-05-14-what-is-kafka.md', '--to', 'concept', '--format=json']);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.from).toBe('docs/wiki/pages/queries/2026-05-14-what-is-kafka.md');
    expect(json.to).toBe('docs/wiki/pages/concept/what-is-kafka.md');
    expect(json.sources).toEqual(['raw/articles/kafka-intro.md']);

    expect(existsSync(join(dir, 'docs/wiki/pages/queries/2026-05-14-what-is-kafka.md'))).toBe(false);
    const newText = readFileSync(join(dir, json.to), 'utf-8');
    expect(newText).toMatch(/type: concept/);
    expect(newText).toMatch(/status: active/);
    expect(newText).toMatch(/sources:\n  - raw\/articles\/kafka-intro\.md/);
    expect(newText).not.toMatch(/question:/);
    expect(newText).not.toMatch(/informed-by:/);
  });

  it('exits 2 when concept slug already exists', () => {
    writeFileSync(join(dir, 'docs/wiki/pages/concept/what-is-kafka.md'),
      `---\nid: what-is-kafka\ntype: concept\ntitle: x\ncreated: 2026-05-01\nupdated: 2026-05-01\nstatus: active\ntags: []\nsources: []\n---\n\n# x\n`);
    const r = runCli(['promote', 'docs/wiki/pages/queries/2026-05-14-what-is-kafka.md', '--to', 'concept', '--format=json']);
    expect(r.status).toBe(2);
    const json = JSON.parse(r.stdout);
    expect(json['existing-path']).toBe('docs/wiki/pages/concept/what-is-kafka.md');
  });

  it('rejects --to other than concept in v1', () => {
    const r = runCli(['promote', 'docs/wiki/pages/queries/2026-05-14-what-is-kafka.md', '--to', 'person', '--format=json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/only --to=concept supported/i);
  });
});
