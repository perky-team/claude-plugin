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
});
