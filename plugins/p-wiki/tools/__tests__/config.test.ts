import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, writeConfig, validateConfig, configPath } from '../lib/config.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-config-'));
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const confluenceBlock = {
  kind: 'confluence',
  siteUrl: 'https://x.atlassian.net',
  spaceKey: 'ENG',
  spaceId: '987',
  rootPageId: '123',
  subParents: { concept: '1', person: '2', source: '3', query: '4' },
};

describe('config v3', () => {
  it('returns null when .pwiki.json is absent', () => {
    expect(readConfig(dir)).toBeNull();
  });

  it('round-trips a v3 config', () => {
    const cfg = {
      primary: 'confluence',
      mirrors: ['fs'],
      destinations: { confluence: confluenceBlock, fs: { kind: 'fs' } },
    };
    writeConfig(dir, cfg);
    expect(readConfig(dir)).toEqual(cfg);
  });

  it('migrates v2 confluence shape on read and persists', () => {
    const v2 = {
      destination: 'confluence',
      confluence: {
        siteUrl: 'https://x.atlassian.net', spaceKey: 'ENG', spaceId: '987',
        rootPageId: '123', subParents: { concept: '1', person: '2', source: '3', query: '4' },
      },
    };
    writeFileSync(configPath(dir), JSON.stringify(v2, null, 2), 'utf-8');
    const got = readConfig(dir);
    expect(got).toEqual({
      primary: 'confluence',
      mirrors: [],
      destinations: { confluence: { kind: 'confluence', ...v2.confluence } },
    });
    // Persisted to disk in v3 shape:
    const onDisk = JSON.parse(readFileSync(configPath(dir), 'utf-8'));
    expect(onDisk).toEqual(got);
  });

  it('migrates v2 fs-explicit shape on read', () => {
    writeFileSync(configPath(dir), JSON.stringify({ destination: 'fs' }, null, 2), 'utf-8');
    const got = readConfig(dir);
    expect(got).toEqual({
      primary: 'fs',
      mirrors: [],
      destinations: { fs: { kind: 'fs' } },
    });
  });

  it('validateConfig rejects missing destinations entry for primary', () => {
    const r = validateConfig({ primary: 'confluence', mirrors: [], destinations: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/destinations\.confluence/);
  });

  it('validateConfig rejects mirror name not present in destinations', () => {
    const r = validateConfig({
      primary: 'confluence',
      mirrors: ['fs'],
      destinations: { confluence: confluenceBlock },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/mirror.*fs/);
  });

  it('validateConfig rejects destination without kind', () => {
    const r = validateConfig({
      primary: 'confluence',
      mirrors: [],
      destinations: { confluence: { ...confluenceBlock, kind: undefined } },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/kind/);
  });

  it('validateConfig rejects missing confluence.spaceId', () => {
    const bad = { ...confluenceBlock, spaceId: undefined };
    const r = validateConfig({ primary: 'confluence', mirrors: [], destinations: { confluence: bad } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/spaceId/);
  });

  it('validateConfig accepts an fs destination with only kind', () => {
    const cfg = { primary: 'fs', mirrors: [], destinations: { fs: { kind: 'fs' } } };
    expect(validateConfig(cfg).ok).toBe(true);
  });

  it('validateConfig accepts a valid sources array', () => {
    const cfg = {
      primary: 'fs',
      mirrors: [],
      sources: ['other'],
      destinations: { fs: { kind: 'fs' }, other: { kind: 'fs', path: '/some/abs/path' } },
    };
    expect(validateConfig(cfg).ok).toBe(true);
  });

  it('validateConfig rejects a source not present in destinations', () => {
    const r = validateConfig({
      primary: 'fs', mirrors: [], sources: ['ghost'],
      destinations: { fs: { kind: 'fs' } },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/source.*ghost/);
  });

  it('validateConfig rejects a source that is also the primary', () => {
    const r = validateConfig({
      primary: 'fs', mirrors: [], sources: ['fs'],
      destinations: { fs: { kind: 'fs' } },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/source.*fs/);
  });

  it('validateConfig rejects a source that is also a mirror', () => {
    const r = validateConfig({
      primary: 'fs', mirrors: ['other'], sources: ['other'],
      destinations: { fs: { kind: 'fs' }, other: { kind: 'fs', path: '/p' } },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/source.*other/);
  });

  it('validateConfig rejects a non-array sources', () => {
    const r = validateConfig({
      primary: 'fs', mirrors: [], sources: 'other',
      destinations: { fs: { kind: 'fs' } },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sources/);
  });

  it('validateConfig rejects an fs block with an empty path', () => {
    const r = validateConfig({
      primary: 'fs', mirrors: [], sources: ['other'],
      destinations: { fs: { kind: 'fs' }, other: { kind: 'fs', path: '' } },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/path/);
  });

  it('validateConfig still accepts a config with no sources field', () => {
    const cfg = { primary: 'fs', mirrors: [], destinations: { fs: { kind: 'fs' } } };
    expect(validateConfig(cfg).ok).toBe(true);
  });

  it('readConfig throws on invalid JSON', () => {
    writeFileSync(configPath(dir), '{not json', 'utf-8');
    expect(() => readConfig(dir)).toThrow();
  });
});
