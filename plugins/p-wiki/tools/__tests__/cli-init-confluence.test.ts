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

  it('writes v3 shape with fs primary and confluence mirror', async () => {
    const fake = createFakeConfluence({
      spaces: [{ id: '100', key: 'ENG', name: 'Eng' }],
      initialPages: [{ id: '200', title: 'Root', parentId: null }],
    });
    try {
      await initConfluence({
        'mirror-confluence': true, 'mirror-site': 'https://x.atlassian.net',
        'mirror-space': 'ENG', 'mirror-parent': '200',
      }, { transport: fake.transport });
    } catch (e: any) {
      expect(e.message).toBe('exit:0');
    }
    const onDisk = JSON.parse(readFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), 'utf-8'));
    expect(onDisk.primary).toBe('fs');
    expect(onDisk.mirrors).toEqual(['confluence-mirror']);
    expect(onDisk.destinations.fs).toEqual({ kind: 'fs' });
    const cm = onDisk.destinations['confluence-mirror'];
    expect(cm.kind).toBe('confluence');
    expect(cm.siteUrl).toBe('https://x.atlassian.net');
    expect(cm.spaceKey).toBe('ENG');
    expect(cm.spaceId).toBe('100');
    expect(cm.rootPageId).toBe('200');
    for (const t of ['concept', 'person', 'source', 'query']) {
      expect(typeof cm.subParents[t]).toBe('string');
      expect(cm.subParents[t]).toBeTruthy();
    }
  });

  it('persists titlePrefix defaulted from the root page title', async () => {
    const fake = createFakeConfluence({
      spaces: [{ id: '100', key: 'ENG', name: 'Eng' }],
      initialPages: [{ id: '200', title: 'Technical Specifications', parentId: null }],
    });
    try {
      await initConfluence({
        confluence: true, site: 'https://x.atlassian.net', space: 'ENG', parent: '200',
      }, { transport: fake.transport });
    } catch (e: any) {
      expect(e.message).toBe('exit:0');
    }
    const onDisk = JSON.parse(readFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), 'utf-8'));
    expect(onDisk.destinations.confluence.titlePrefix).toBe('Technical Specifications');
    // Structural containers carry the prefixed title (Index is created later by sync).
    const titles = [...fake.pageById.values()].map((p: any) => p.title);
    expect(titles).toContain('Technical Specifications — Concepts');
    expect(titles).toContain('Technical Specifications — Queries');
  });

  it('honors an explicit --title-prefix', async () => {
    const fake = createFakeConfluence({
      spaces: [{ id: '100', key: 'ENG', name: 'Eng' }],
      initialPages: [{ id: '200', title: 'Root', parentId: null }],
    });
    try {
      await initConfluence({
        confluence: true, site: 'https://x.atlassian.net', space: 'ENG', parent: '200',
        'title-prefix': 'Custom NS',
      }, { transport: fake.transport });
    } catch (e: any) {
      expect(e.message).toBe('exit:0');
    }
    const onDisk = JSON.parse(readFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), 'utf-8'));
    expect(onDisk.destinations.confluence.titlePrefix).toBe('Custom NS');
    const titles = [...fake.pageById.values()].map((p: any) => p.title);
    expect(titles).toContain('Custom NS — Concepts');
  });

  it('two p-wikis under different roots in one space do not collide', async () => {
    const fake = createFakeConfluence({
      spaces: [{ id: '100', key: 'ENG', name: 'Eng' }],
      initialPages: [
        { id: '200', title: 'Alpha', parentId: null },
        { id: '300', title: 'Beta', parentId: null },
      ],
    });
    const run = async (parent: string) => {
      try {
        await initConfluence({
          confluence: true, site: 'https://x.atlassian.net', space: 'ENG', parent,
        }, { transport: fake.transport });
      } catch (e: any) {
        expect(e.message).toBe('exit:0');     // must NOT be an HTTP 400
      }
    };
    await run('200');
    const cfg1 = JSON.parse(readFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), 'utf-8'));
    expect(cfg1.destinations.confluence.titlePrefix).toBe('Alpha');
    await run('300');
    const cfg2 = JSON.parse(readFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), 'utf-8'));
    expect(cfg2.destinations.confluence.titlePrefix).toBe('Beta');
  });

  it('init --mirror-confluence is idempotent (same config, no new sub-parents)', async () => {
    const fake = createFakeConfluence({
      spaces: [{ id: '100', key: 'ENG', name: 'Eng' }],
      initialPages: [{ id: '200', title: 'Root', parentId: null }],
    });
    const run = async () => {
      try {
        await initConfluence({
          'mirror-confluence': true, 'mirror-site': 'https://x.atlassian.net',
          'mirror-space': 'ENG', 'mirror-parent': '200',
        }, { transport: fake.transport });
      } catch (e: any) {
        expect(e.message).toBe('exit:0');
      }
    };
    await run();
    const first = readFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), 'utf-8');
    const sizeAfterFirst = fake.pageById.size;
    await run();
    const second = readFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), 'utf-8');
    expect(second).toBe(first);
    expect(fake.pageById.size).toBe(sizeAfterFirst);
  });
});
