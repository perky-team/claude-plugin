import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { searchCommand } from '../pwiki.mjs';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pwiki.mjs');

const PAGE = (id: string, title: string, extra = '') =>
  `---\nid: ${id}\ntype: concept\ntitle: ${title}\ncreated: 2026-05-01\nupdated: 2026-05-01\nstatus: active\ntags: []\nsources: []\n---\n\n# ${title}\n\nKafka content. ${extra}\n`;

describe('pwiki search — union over sources (FS primary + FS source)', () => {
  let primaryDir: string;
  let sourceDir: string;
  beforeEach(() => {
    primaryDir = mkdtempSync(join(tmpdir(), 'pwiki-search-primary-'));
    sourceDir = mkdtempSync(join(tmpdir(), 'pwiki-search-source-'));
    mkdirSync(join(primaryDir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
    mkdirSync(join(sourceDir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
    writeFileSync(join(primaryDir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
    writeFileSync(join(primaryDir, 'docs', 'wiki', 'pages', 'concept', 'kafka.md'), PAGE('kafka', 'Kafka'));
    writeFileSync(join(sourceDir, 'docs', 'wiki', 'pages', 'concept', 'kafka-ext.md'), PAGE('kafka-ext', 'Kafka External'));
    writeFileSync(join(primaryDir, 'docs', 'wiki', '.pwiki.json'), JSON.stringify({
      primary: 'fs', mirrors: [], sources: ['other'],
      destinations: { fs: { kind: 'fs' }, other: { kind: 'fs', path: sourceDir } },
    }), 'utf-8');
  });
  afterEach(() => {
    rmSync(primaryDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it('returns results from primary and source, each tagged with its source', () => {
    const r = spawnSync('node', [cli, 'search', 'kafka', '--format=json'], { cwd: primaryDir, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    const bySource = new Map(json.results.map((x: any) => [x.source, x]));
    expect(bySource.has('fs')).toBe(true);
    expect(bySource.has('other')).toBe(true);
    expect(json.total).toBe(2);
    expect(json.warnings).toEqual([]);
  });
});

describe('pwiki search — a failing source becomes a warning (in-process)', () => {
  let dir: string;
  let cwd: string;
  let exitSpy: any;
  let stdoutSpy: any;
  let out: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pwiki-search-warn-'));
    mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
    writeFileSync(join(dir, 'docs', 'wiki', 'pages', 'concept', 'kafka.md'), PAGE('kafka', 'Kafka'));
    writeFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), JSON.stringify({
      primary: 'fs', mirrors: [], sources: ['conf'],
      destinations: {
        fs: { kind: 'fs' },
        conf: {
          kind: 'confluence', siteUrl: 'https://x', spaceKey: 'ENG', spaceId: 'S1',
          rootPageId: '100', subParents: { concept: '101', person: '102', source: '103', query: '104' },
        },
      },
    }), 'utf-8');
    cwd = process.cwd();
    process.chdir(dir);
    out = '';
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as any);
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('keeps primary results and records the source error', async () => {
    // Transport that fails every request → confluence source.search throws.
    const failing = async () => ({ status: 500, headers: {}, body: { message: 'boom' } });
    try {
      await searchCommand({ _: ['kafka'], format: 'json' }, { transport: failing });
    } catch (e: any) {
      expect(e.message).toBe('exit:0');
    }
    const json = JSON.parse(out);
    expect(json.results.some((x: any) => x.source === 'fs')).toBe(true);
    expect(json.warnings).toHaveLength(1);
    expect(json.warnings[0].source).toBe('conf');
    expect(json.warnings[0].code).toBe('network-error');
  });
});
