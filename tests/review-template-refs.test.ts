import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findPlugins, findSkills } from './helpers.js';

// Post-Wave-A: each `requesting-*-review` skill dispatches a reviewer via
// `Task` tool with `general-purpose` + an inline template file colocated
// with the SKILL.md. This invariant catches drift where a template is
// referenced but missing, or where the discipline structure ("What is
// NOT your scope") is lost from the template body.

// Matches `${CLAUDE_SKILL_DIR}/<filename>.md` references inside SKILL.md
// (the canonical way to point at colocated templates).
const TEMPLATE_REF = /\$\{CLAUDE_SKILL_DIR\}\/([a-z][a-z0-9-]*\.md)/g;

describe('reviewer template references', () => {
  const plugins = findPlugins();

  for (const plugin of plugins) {
    const skills = findSkills(plugin.dir);

    // Collect (skill, template-filename) pairs referenced from each SKILL.md.
    const refs: { skill: string; template: string; templatePath: string }[] = [];
    for (const skill of skills) {
      for (const match of skill.raw.matchAll(TEMPLATE_REF)) {
        refs.push({
          skill: skill.name,
          template: match[1],
          templatePath: join(skill.dir, match[1]),
        });
      }
    }

    if (refs.length === 0) continue;

    describe(`plugin: ${plugin.name}`, () => {
      for (const { skill, template, templatePath } of refs) {
        describe(`skill "${skill}" references "${template}"`, () => {
          it('the template file exists alongside SKILL.md', () => {
            expect(
              existsSync(templatePath),
              `template not found: ${templatePath}`,
            ).toBe(true);
          });

          // Surviving structural assertion from the old agents.test.ts:
          // reviewer templates must declare a "What is NOT your scope"
          // section — the scope-discipline structure protected by the
          // smoke-test investigation (commit ad2b097).
          it('template body declares a "What is NOT your scope" section', () => {
            const body = readFileSync(templatePath, 'utf-8');
            expect(body).toContain('## What is NOT your scope');
          });
        });
      }
    });
  }
});
