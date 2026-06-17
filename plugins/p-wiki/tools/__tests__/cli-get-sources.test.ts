import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';
import { getPage } from '../pwiki.mjs';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pwiki.mjs');

describe('pwiki get --source (FS primary + FS source)', () => {
  let primaryDir: string;
  let sourceDir: string;
  beforeEach(() => {
    primaryDir = mkdtempSync(join(tmpdir(), 'pwiki-get-primary-'));
    sourceDir = mkdtempSync(join(tmpdir(), 'pwiki-get-source-'));
    mkdirSync(join(primaryDir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
    mkdirSync(join(sourceDir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
    writeFileSync(join(primaryDir, 'docs', 'wiki', 'CLAUDE.md'), '# rules');
    writeFileSync(join(primaryDir, 'docs', 'wiki', 'pages', 'concept', 'home.md'),
      '---\nid: home\ntype: concept\ntitle: Home\n---\n\n# Home\n\nprimary body\n');
    writeFileSync(join(sourceDir, 'docs', 'wiki', 'pages', 'concept', 'ext.md'),
      '---\nid: ext\ntype: concept\ntitle: Ext\n---\n\n# Ext\n\nsource body\n');
    writeFileSync(join(primaryDir, 'docs', 'wiki', '.pwiki.json'), JSON.stringify({
      primary: 'fs', mirrors: [], sources: ['other'],
      destinations: { fs: { kind: 'fs' }, other: { kind: 'fs', path: sourceDir } },
    }), 'utf-8');
  });
  afterEach(() => {
    rmSync(primaryDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it('reads a page from the named source', () => {
    const r = spawnSync('node', [cli, 'get', 'docs/wiki/pages/concept/ext.md', '--source=other', '--format=json'],
      { cwd: primaryDir, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).body).toContain('source body');
  });

  it('reads from primary when --source is omitted', () => {
    const r = spawnSync('node', [cli, 'get', 'docs/wiki/pages/concept/home.md', '--format=json'],
      { cwd: primaryDir, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).body).toContain('primary body');
  });

  it('unknown --source → exit 1 with error.code unknown-source', () => {
    const r = spawnSync('node', [cli, 'get', 'docs/wiki/pages/concept/ext.md', '--source=nope', '--format=json'],
      { cwd: primaryDir, encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe('unknown-source');
  });
});

describe('pwiki get --source (Confluence source, fake transport)', () => {
  let dir: string;
  let cwd: string;
  let exitSpy: any;
  let stdoutSpy: any;
  let out: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pwiki-get-confsrc-'));
    mkdirSync(join(dir, 'docs', 'wiki', 'pages', 'concept'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), 'placeholder');
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
    process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
    process.env.PWIKI_CONFLUENCE_TOKEN = 't';
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

  it('rebuilds identity via the subParents children scan and reads the source page', async () => {
    const adf = { type: 'doc', version: 1, content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Foo' }] }] };
    const fake = createFakeConfluence({
      spaces: [{ id: 'S1', key: 'ENG', name: 'Eng' }],
      initialPages: [
        { id: '200', title: 'Foo', parentId: '101', body: adf, properties: [
          { key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' },
          { key: 'pwiki-title', value: 'Foo' }, { key: 'pwiki-tags', value: '["streaming"]' },
        ] },
      ],
    });
    try {
      await getPage({ _: ['confluence://concept/foo'], source: 'conf', format: 'json' }, { transport: fake.transport });
    } catch (e: any) {
      expect(e.message).toBe('exit:0');
    }
    const json = JSON.parse(out);
    expect(json.frontmatter.title).toBe('Foo');
    expect(json.body).toBe('# Foo');
  });
});
