import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { findPlugins, findSkills } from './helpers.js';

describe('plugin README skill coverage', () => {
  const plugins = findPlugins();

  for (const plugin of plugins) {
    const skills = findSkills(plugin.dir);
    if (skills.length === 0) continue;

    describe(`plugin: ${plugin.name}`, () => {
      it('README.md exists', () => {
        expect(existsSync(plugin.readmePath)).toBe(true);
      });

      const readme = readFileSync(plugin.readmePath, 'utf-8');

      for (const skill of skills) {
        it(`README mentions skill "${skill.name}"`, () => {
          // Tight match: require either backticked (`init`) or slash-command
          // (`/<plugin>:<skill>`) form. Bare-word match is rejected — short
          // skill names like `add` / `set` / `next` would false-positive on
          // unrelated prose (e.g. "add a destination" doesn't document the
          // /p-tasks:add skill).
          const ticked   = new RegExp('`' + skill.name + '`');
          const slashCmd = new RegExp(`/${plugin.name}:${skill.name}\\b`);
          const found = ticked.test(readme) || slashCmd.test(readme);
          expect(
            found,
            `README at ${plugin.readmePath} does not mention skill "${skill.name}" in backtick or slash-command form. Add it to the Skills/Commands table or remove the skill directory.`,
          ).toBe(true);
        });
      }
    });
  }
});
