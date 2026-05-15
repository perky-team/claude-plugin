import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, writeConfig, validateConfig } from '../lib/config.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwiki-config-'));
  mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('config', () => {
  it('returns null when .pwiki.json is absent', () => {
    expect(readConfig(dir)).toBeNull();
  });

  it('round-trips a Confluence config', () => {
    const cfg = {
      destination: 'confluence',
      confluence: {
        siteUrl: 'https://x.atlassian.net', spaceKey: 'ENG', spaceId: '987',
        rootPageId: '123', subParents: { concept: '1', person: '2', source: '3', query: '4' },
      },
    };
    writeConfig(dir, cfg);
    expect(readConfig(dir)).toEqual(cfg);
  });

  it('validateConfig rejects missing confluence.spaceId', () => {
    const cfg = { destination: 'confluence', confluence: { siteUrl: 'x', spaceKey: 'E', rootPageId: '1', subParents: { concept: '1', person: '2', source: '3', query: '4' } } };
    const r = validateConfig(cfg);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/spaceId/);
  });

  it('validateConfig accepts destination=fs with no other fields', () => {
    expect(validateConfig({ destination: 'fs' }).ok).toBe(true);
  });

  it('readConfig throws on invalid JSON', () => {
    writeFileSync(join(dir, 'docs', 'wiki', '.pwiki.json'), '{not json', 'utf-8');
    expect(() => readConfig(dir)).toThrow();
  });
});
