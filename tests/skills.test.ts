import { describe, expect, it } from 'vitest';
import { findPlugins, findSkills } from './helpers.js';

const DESCRIPTION_MIN_CHARS = 30;
const BODY_MIN_CHARS = 100;

describe('skills', () => {
  const plugins = findPlugins();

  for (const plugin of plugins) {
    const skills = findSkills(plugin.dir);

    describe(`plugin: ${plugin.name}`, () => {
      it('has at least one skill', () => {
        expect(skills.length).toBeGreaterThan(0);
      });

      for (const skill of skills) {
        describe(`skill: ${skill.name}`, () => {
          it('SKILL.md raw content is non-empty', () => {
            expect(skill.raw.length).toBeGreaterThan(0);
          });

          it('frontmatter has a string "name"', () => {
            expect(typeof skill.frontmatter.name).toBe('string');
            expect((skill.frontmatter.name as string).length).toBeGreaterThan(0);
          });

          it('frontmatter.name matches the skill directory name', () => {
            expect(skill.frontmatter.name).toBe(skill.name);
          });

          it('frontmatter has a non-empty string "description"', () => {
            expect(typeof skill.frontmatter.description).toBe('string');
            expect((skill.frontmatter.description as string).length).toBeGreaterThan(DESCRIPTION_MIN_CHARS);
          });

          it('frontmatter "allowed-tools" is a non-empty string when present', () => {
            const v = skill.frontmatter['allowed-tools'];
            if (v !== undefined) {
              expect(typeof v).toBe('string');
              expect((v as string).length).toBeGreaterThan(0);
            }
          });

          it('frontmatter "argument-hint" is a string when present', () => {
            const v = skill.frontmatter['argument-hint'];
            if (v !== undefined) {
              expect(typeof v).toBe('string');
            }
          });

          it('markdown body is non-trivial (>100 chars)', () => {
            expect(skill.body.trim().length).toBeGreaterThan(BODY_MIN_CHARS);
          });
        });
      }
    });
  }
});
