import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import semver from 'semver';
import { findPlugins } from './helpers.js';

const KEBAB_CASE = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const README_MIN_CHARS = 50;

describe('plugin manifests', () => {
  const plugins = findPlugins();

  it('at least one plugin exists', () => {
    expect(plugins.length).toBeGreaterThan(0);
  });

  for (const plugin of plugins) {
    describe(`plugin: ${plugin.name}`, () => {
      it('plugin.json has non-empty name, version, description', () => {
        expect(typeof plugin.manifest.name).toBe('string');
        expect(plugin.manifest.name.length).toBeGreaterThan(0);
        expect(typeof plugin.manifest.version).toBe('string');
        expect(plugin.manifest.version.length).toBeGreaterThan(0);
        expect(typeof plugin.manifest.description).toBe('string');
        expect(plugin.manifest.description.length).toBeGreaterThan(0);
      });

      it('plugin.json name matches the plugin directory name', () => {
        expect(plugin.manifest.name).toBe(plugin.name);
      });

      it('plugin.json name is kebab-case', () => {
        expect(plugin.manifest.name).toMatch(KEBAB_CASE);
      });

      it('plugin.json version parses as semver', () => {
        expect(semver.valid(plugin.manifest.version)).not.toBeNull();
      });

      it('plugin has a README.md', () => {
        expect(existsSync(plugin.readmePath)).toBe(true);
        expect(statSync(plugin.readmePath).isFile()).toBe(true);
      });

      it('plugin README.md is non-trivial (>50 chars)', () => {
        const content = readFileSync(plugin.readmePath, 'utf-8');
        expect(content.length).toBeGreaterThan(README_MIN_CHARS);
      });
    });
  }
});
