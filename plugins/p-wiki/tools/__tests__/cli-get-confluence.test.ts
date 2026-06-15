import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';
import { getPage } from '../pwiki.mjs';

let dir: string;
let cwd: string;
let exitSpy: any;
let stdoutSpy: any;
let out: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-get-conf-'));
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), 'placeholder', 'utf-8');
  writeFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), JSON.stringify({
    primary: 'confluence',
    mirrors: [],
    destinations: {
      confluence: {
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

describe('getPage (Confluence, fake transport)', () => {
  it('reads body (ADF→markdown) and frontmatter (from properties)', async () => {
    const adf = { type: 'doc', version: 1, content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Foo' }] }] };
    const fake = createFakeConfluence({
      spaces: [{ id: 'S1', key: 'ENG', name: 'Eng' }],
      initialPages: [
        { id: '200', title: 'Foo', parentId: '101', body: adf, properties: [
          { key: 'pwiki-id', value: 'foo' }, { key: 'pwiki-type', value: 'concept' },
          { key: 'pwiki-title', value: 'Foo' }, { key: 'pwiki-created', value: '2026-05-15' },
          { key: 'pwiki-updated', value: '2026-05-15' }, { key: 'pwiki-status', value: 'active' },
          { key: 'pwiki-tags', value: '["streaming"]' }, { key: 'pwiki-sources', value: '[]' },
        ] },
      ],
    });
    try {
      await getPage({ _: ['confluence://concept/foo'], format: 'json' }, { transport: fake.transport });
    } catch (e: any) {
      expect(e.message).toBe('exit:0');
    }
    const json = JSON.parse(out);
    expect(json.path).toBe('confluence://concept/foo');
    expect(json.frontmatter.title).toBe('Foo');
    expect(json.frontmatter.tags).toEqual(['streaming']);
    expect(json.body).toBe('# Foo');
  });
});
