import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeConfluence } from './fixtures/fake-confluence.mjs';
import { initConfluence } from '../pwiki.mjs';

let dir: string;
let cwd: string;
let exitSpy: any;
let stdoutSpy: any;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-init-conf-'));
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'wiki', 'CLAUDE.md'), 'placeholder', 'utf-8');
  cwd = process.cwd();
  process.chdir(dir);
  process.env.PWIKI_CONFLUENCE_EMAIL = 'a@b.c';
  process.env.PWIKI_CONFLUENCE_TOKEN = 't';
  // Capture process.exit so initConfluence's emitJson doesn't kill the test runner:
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
  exitSpy.mockRestore();
  stdoutSpy.mockRestore();
});

describe('initConfluence', () => {
  it('writes v3 shape with confluence primary and fs mirror', async () => {
    const fake = createFakeConfluence({
      spaces: [{ id: '100', key: 'ENG', name: 'Eng' }],
      initialPages: [{ id: '200', title: 'Root', parentId: null }],
    });
    try {
      await initConfluence({
        confluence: true, site: 'https://x.atlassian.net', space: 'ENG', parent: '200',
        'mirror-fs': true,
      }, { transport: fake.transport });
    } catch (e: any) {
      expect(e.message).toBe('exit:0');
    }
    const onDisk = JSON.parse(readFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), 'utf-8'));
    expect(onDisk.primary).toBe('confluence');
    expect(onDisk.mirrors).toEqual(['fs']);
    expect(onDisk.destinations.confluence.kind).toBe('confluence');
    expect(onDisk.destinations.confluence.spaceKey).toBe('ENG');
    expect(onDisk.destinations.fs).toEqual({ kind: 'fs' });
  });

  it('writes v3 shape with no mirrors when neither flag is set', async () => {
    const fake = createFakeConfluence({
      spaces: [{ id: '100', key: 'ENG', name: 'Eng' }],
      initialPages: [{ id: '200', title: 'Root', parentId: null }],
    });
    try {
      await initConfluence({
        confluence: true, site: 'https://x.atlassian.net', space: 'ENG', parent: '200',
      }, { transport: fake.transport });
    } catch (e: any) {
      expect(e.message).toBe('exit:0');
    }
    const onDisk = JSON.parse(readFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), 'utf-8'));
    expect(onDisk.primary).toBe('confluence');
    expect(onDisk.mirrors).toEqual([]);
    expect(onDisk.destinations.fs).toBeUndefined();
  });
});
