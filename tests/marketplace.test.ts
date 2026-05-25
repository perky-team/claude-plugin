import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  type Marketplace,
  type PluginManifest,
  readMarketplace,
  repoRoot,
} from './helpers.js';

describe('marketplace.json', () => {
  let marketplace: Marketplace;
  let marketplacePath: string;

  beforeAll(() => {
    const m = readMarketplace();
    marketplace = m.data;
    marketplacePath = m.path;
  });

  it('exists at .claude-plugin/marketplace.json', () => {
    expect(existsSync(marketplacePath)).toBe(true);
  });

  it('is valid JSON (already parsed by helper)', () => {
    expect(typeof marketplace).toBe('object');
    expect(marketplace).not.toBeNull();
  });

  it('has a non-empty top-level "name" string', () => {
    expect(typeof marketplace.name).toBe('string');
    expect(marketplace.name.length).toBeGreaterThan(0);
  });

  it('has a "plugins" array', () => {
    expect(Array.isArray(marketplace.plugins)).toBe(true);
    expect(marketplace.plugins.length).toBeGreaterThan(0);
  });

  it('contains no duplicate plugin names', () => {
    const names = marketplace.plugins.map((p) => p.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  describe('each plugin entry', () => {
    it('has non-empty name, source, description strings', () => {
      for (const entry of marketplace.plugins) {
        expect(typeof entry.name).toBe('string');
        expect(entry.name.length).toBeGreaterThan(0);
        expect(typeof entry.source).toBe('string');
        expect(entry.source.length).toBeGreaterThan(0);
        expect(typeof entry.description).toBe('string');
        expect(entry.description.length).toBeGreaterThan(0);
      }
    });

    it('source resolves to an existing directory', () => {
      for (const entry of marketplace.plugins) {
        const abs = join(repoRoot(), entry.source);
        expect(existsSync(abs), `${entry.source} should exist`).toBe(true);
        expect(statSync(abs).isDirectory(), `${entry.source} should be a directory`).toBe(true);
      }
    });

    it('source directory contains .claude-plugin/plugin.json', () => {
      for (const entry of marketplace.plugins) {
        const manifestPath = join(repoRoot(), entry.source, '.claude-plugin', 'plugin.json');
        expect(existsSync(manifestPath), `missing manifest at ${manifestPath}`).toBe(true);
      }
    });

    it('plugin.json name matches the marketplace entry name', () => {
      for (const entry of marketplace.plugins) {
        const manifestPath = join(repoRoot(), entry.source, '.claude-plugin', 'plugin.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest;
        expect(manifest.name, `${entry.source} plugin.json name`).toBe(entry.name);
      }
    });
  });

  describe('repo README plugins', () => {
    it('mentions every plugin from the marketplace', () => {
      const readme = readFileSync(join(repoRoot(), 'README.md'), 'utf-8');
      for (const entry of marketplace.plugins) {
        expect(readme, `README must mention plugin "${entry.name}"`).toContain(entry.name);
      }
    });
  });
});
