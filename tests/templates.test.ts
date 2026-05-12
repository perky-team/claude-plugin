import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPlugins, findSkills, findTemplates } from './helpers.js';

// Matches every `${CLAUDE_SKILL_DIR}/../_shared/templates/<filename>` reference.
// The filename must contain a dot (i.e. have an extension) to exclude bare
// placeholder names like "X" used in prose examples inside SKILL.md files.
const TEMPLATE_REF = /\$\{CLAUDE_SKILL_DIR\}\/\.\.\/_shared\/templates\/([^\s`)]*\.[^\s`)]+)/g;

describe('templates', () => {
  const plugins = findPlugins();

  for (const plugin of plugins) {
    const templates = findTemplates(plugin.dir);
    const skills = findSkills(plugin.dir);

    // Aggregate every template filename referenced by any skill in this plugin.
    const referenced = new Set<string>();
    for (const skill of skills) {
      for (const match of skill.raw.matchAll(TEMPLATE_REF)) {
        referenced.add(match[1]);
      }
    }

    describe(`plugin: ${plugin.name}`, () => {
      if (templates.length > 0) {
        for (const tpl of templates) {
          it(`template "${tpl.filename}" is non-empty`, () => {
            expect(tpl.content.trim().length).toBeGreaterThan(0);
          });

          it(`template "${tpl.filename}" is referenced by at least one SKILL.md`, () => {
            expect(referenced.has(tpl.filename), `${tpl.filename} is not referenced by any SKILL.md (dead template)`).toBe(true);
          });
        }
      }

      for (const skill of skills) {
        const refsInSkill = [...skill.raw.matchAll(TEMPLATE_REF)].map((m) => m[1]);
        for (const ref of refsInSkill) {
          it(`SKILL.md "${skill.name}" references existing template "${ref}"`, () => {
            const tplPath = join(plugin.dir, 'skills', '_shared', 'templates', ref);
            expect(existsSync(tplPath), `template not found: ${tplPath}`).toBe(true);
          });
        }
      }
    });
  }
});
