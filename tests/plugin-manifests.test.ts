import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import semver from 'semver';
import { findPlugins } from './helpers.js';

const KEBAB_CASE = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const README_MIN_CHARS = 50;

// A plugin's CLI lives at tools/<name without dashes>.mjs (p-shed → tools/pshed.mjs).
const cliPath = (plugin: { dir: string; name: string }): string | null => {
  const p = join(plugin.dir, 'tools', `${plugin.name.replace(/-/g, '')}.mjs`);
  return existsSync(p) ? p : null;
};

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

      // Regression: every CLI used to carry its own hardcoded VERSION constant, and the
      // release procedure bumps plugin.json#version only — so `pshed --version` printed
      // 0.1.0 while the plugin shipped 0.8.0 (p-wiki: 3.3.0 vs 4.12.2). The existing
      // cli-entry tests only matched the semver SHAPE, so the drift was invisible.
      //
      // Discovery is by source text rather than a hardcoded list: a new CLI that adds
      // --version is covered automatically, and a CLI whose --version breaks fails here
      // instead of silently dropping out of the suite. Plugins with no CLI (p-flow,
      // p-statusline) have nothing to check; so would a CLI with no --version flag, if one
      // is ever added.
      const cli = cliPath(plugin);
      const declaresVersionFlag = cli !== null && readFileSync(cli, 'utf-8').includes('--version');
      it.runIf(declaresVersionFlag)('CLI --version prints plugin.json#version', () => {
        const r = spawnSync(process.execPath, [cli as string, '--version'], { encoding: 'utf-8' });
        expect(r.stderr).toBe('');
        expect(r.status).toBe(0);
        expect(r.stdout.trim()).toBe(plugin.manifest.version);
      }, 20_000);
    });
  }
});
