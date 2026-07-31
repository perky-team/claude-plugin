import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const root = repoRoot();
const README = readFileSync(join(root, 'README.md'), 'utf-8');
const MARKETPLACE = JSON.parse(
  readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf-8'),
) as { plugins: { name: string; source: string }[] };

/** Skill directories on disk: one per skill, `_shared` is a helper bundle, not a skill. */
function skillsOnDisk(plugin: string): string[] {
  const dir = join(root, 'plugins', plugin, 'skills');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((e) => e !== '_shared' && statSync(join(dir, e)).isDirectory())
    .sort();
}

/** The plugin's own section in the root README, up to the next `### `. */
function section(plugin: string): string {
  const lines = README.split('\n');
  const start = lines.findIndex((l) => l.startsWith('### ') && l.includes(`\`${plugin}\``));
  if (start === -1) throw new Error(`No section for ${plugin} in the root README`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('### ') || l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** Names from a `Skills: \`a\`, \`b\`.` line inside a section. */
function listedSkills(body: string): string[] {
  const line = body.split('\n').find((l) => /^Skills:/.test(l.trim()));
  if (!line) throw new Error('No "Skills:" line in the section');
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort();
}

/**
 * `plugin-readme-coverage.test.ts` keeps each plugin's own README honest, but nothing
 * watched the root one — and it had drifted on almost every plugin at once: p-wiki was
 * missing reconcile and sync, p-tasks list, p-graph query, p-shed reset-breaker,
 * p-observe tui, p-statusline help, and p-flow showed six skills out of sixteen. The
 * root README is the first page a reader sees, so a stale list there is the most
 * expensive kind.
 */
describe('root README lists every plugin and its real skills', () => {
  it('marketplace has plugins to check', () => {
    expect(MARKETPLACE.plugins.length).toBeGreaterThan(0);
  });

  for (const { name } of MARKETPLACE.plugins) {
    it(`${name} has a section in the root README`, () => {
      expect(() => section(name)).not.toThrow();
    });

    it(`${name}'s Skills line matches the skills/ directory`, () => {
      const disk = skillsOnDisk(name);
      if (disk.length === 0) return; // plugin ships no skills/ dir — nothing to compare
      expect(listedSkills(section(name))).toEqual(disk);
    });
  }

  it('every plugin in the marketplace is reachable from the install line', () => {
    // The install section names the valid <plugin-name> values; a new plugin missing
    // there leaves users guessing what to type.
    const installLine = README.split('\n').find((l) => l.includes('`<plugin-name>` is one of'));
    expect(installLine).toBeDefined();
    for (const { name } of MARKETPLACE.plugins) {
      expect(installLine, `${name} missing from the install line`).toContain(`\`${name}\``);
    }
  });
});
