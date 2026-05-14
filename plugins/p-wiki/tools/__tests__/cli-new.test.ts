import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pwiki.mjs');

let dir: string;
function runCli(args: string[]) {
  return spawnSync('node', [cli, ...args], { cwd: dir, encoding: 'utf-8' });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-new-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pwiki new', () => {
  it('creates a concept and prints JSON', () => {
    const r = runCli(['new', 'concept', '--title', 'Kafka', '--tags', 'streaming,queues', '--format=json']);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.created).toBe(true);
    expect(json.slug).toBe('kafka');
    expect(json.path).toBe('docs/wiki/pages/concept/kafka.md');
  });

  it('rejects unknown type with exit 1', () => {
    const r = runCli(['new', 'gibberish', '--title', 'X', '--format=json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown type/i);
  });

  it('rejects missing --title with exit 1', () => {
    const r = runCli(['new', 'concept', '--format=json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--title.*required/i);
  });

  it('exits 2 on slug conflict (default fail) with conflict info in JSON', () => {
    runCli(['new', 'concept', '--title', 'Foo', '--format=json']);
    const r = runCli(['new', 'concept', '--title', 'Foo', '--format=json']);
    expect(r.status).toBe(2);
    const json = JSON.parse(r.stdout);
    expect(json['existing-path']).toBe('docs/wiki/pages/concept/foo.md');
    expect(json['date-suffix-slug']).toMatch(/^foo-\d{4}-\d{2}-\d{2}$/);
  });

  it('retries with --on-conflict=date-suffix', () => {
    runCli(['new', 'concept', '--title', 'Foo', '--format=json']);
    const r = runCli(['new', 'concept', '--title', 'Foo', '--on-conflict=date-suffix', '--format=json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).slug).toMatch(/^foo-\d{4}-\d{2}-\d{2}$/);
  });

  it('creates raw-paste with body from stdin', () => {
    const r = spawnSync('node', [cli, 'new', 'raw-paste', '--title', 'Note', '--ingested-from', '-', '--format=json'],
      { cwd: dir, encoding: 'utf-8', input: 'Paste body line 1\nLine 2\n' });
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.path).toMatch(/^docs\/wiki\/raw\/pastes\/note\.md$/);
  });

  it('exits 1 when run outside a p-wiki repo', () => {
    const orphan = mkdtempSync(join(tmpdir(), 'pwiki-orphan-'));
    const r = spawnSync('node', [cli, 'new', 'concept', '--title', 'X', '--format=json'],
      { cwd: orphan, encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not inside a p-wiki repo/i);
    rmSync(orphan, { recursive: true, force: true });
  });
});
