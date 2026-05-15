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
  dir = mkdtempSync(join(tmpdir(), 'pwiki-e2e-'));
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'queries'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pwiki CLI end-to-end', () => {
  it('runs new → search → lint → promote', () => {
    // new concept
    const createR = runCli(['new', 'concept', '--title', 'Foo', '--format=json']);
    expect(createR.status).toBe(0);
    const created = JSON.parse(createR.stdout);
    expect(created.path).toBe('docs/wiki/pages/concept/foo.md');

    // search finds it
    const searchR = runCli(['search', 'foo', '--format=json']);
    expect(searchR.status).toBe(0);
    const search = JSON.parse(searchR.stdout);
    expect(search.results.some((r: any) => r.path === created.path)).toBe(true);

    // lint runs
    const lintR = runCli(['lint', '--format=json']);
    expect(lintR.status).toBe(0);

    // create query and promote
    runCli(['new', 'query', '--title', 'What is foo', '--question', 'What is foo?',
      '--informed-by', created.path, '--format=json']);
    // For type=query, our slug gets a YYYY-MM-DD- prefix (per spec §3).
    // To make this assertion robust, search in='all' and find the query record.
    const listR = runCli(['search', 'foo', '--in=all', '--format=json']);
    const queryRec = JSON.parse(listR.stdout).results.find((r: any) => r.type === 'query');
    expect(queryRec).toBeDefined();

    const promoteR = runCli(['promote', queryRec.path, '--to', 'concept', '--format=json']);
    expect(promoteR.status).toBe(0);
  });

  it('runs backlinks → index sequence on a populated wiki', () => {
    // Create a target concept page.
    const aR = runCli(['new', 'concept', '--title', 'Kafka', '--format=json']);
    expect(aR.status).toBe(0);
    const a = JSON.parse(aR.stdout);
    expect(a.path).toBe('docs/wiki/pages/concept/kafka.md');

    // First backlinks call — pristine wiki, no other pages mention "Kafka".
    const bR1 = runCli(['backlinks', a.path, '--format=json']);
    expect(bR1.status).toBe(0);
    expect(JSON.parse(bR1.stdout).total).toBe(0);

    // Create a second concept page; manually edit its body to mention "Kafka".
    const cR = runCli(['new', 'concept', '--title', 'Streaming', '--format=json']);
    expect(cR.status).toBe(0);
    const c = JSON.parse(cR.stdout);
    // Append a sentence mentioning "Kafka" to its body. Reuse fs since we're in the test process.
    const { readFileSync, writeFileSync } = require('node:fs');
    const { join } = require('node:path');
    const cAbs = join(dir, c.path);
    const text = readFileSync(cAbs, 'utf-8');
    writeFileSync(cAbs, text + '\nWe use Kafka here.\n');

    // Second backlinks call — should insert one link into Streaming.
    const bR2 = runCli(['backlinks', a.path, '--format=json']);
    expect(bR2.status).toBe(0);
    const bJson = JSON.parse(bR2.stdout);
    expect(bJson.total).toBe(1);
    const updated = readFileSync(cAbs, 'utf-8');
    expect(updated).toContain('We use [Kafka](kafka.md) here.');

    // Re-run is idempotent.
    const bR3 = runCli(['backlinks', a.path, '--format=json']);
    expect(bR3.status).toBe(0);
    expect(JSON.parse(bR3.stdout).total).toBe(0);

    // Index regeneration.
    const iR = runCli(['index', '--format=json']);
    expect(iR.status).toBe(0);
    const iJson = JSON.parse(iR.stdout);
    expect(iJson.groups.concept).toBe(2);
    const indexText = readFileSync(join(dir, 'docs/wiki/index.md'), 'utf-8');
    expect(indexText).toContain('- [Kafka](pages/concept/kafka.md)');
    expect(indexText).toContain('- [Streaming](pages/concept/streaming.md)');

    // index --format=text prints without writing (file is preserved from above).
    const iR2 = runCli(['index', '--format=text']);
    expect(iR2.status).toBe(0);
    expect(iR2.stdout).toContain('# Wiki index');

    // Lint should pass — new backlinks introduce no dead links.
    const lR = runCli(['lint', '--format=json']);
    expect(lR.status).toBe(0);
    const lJson = JSON.parse(lR.stdout);
    expect(lJson.totals.errors).toBe(0);
  });
});
