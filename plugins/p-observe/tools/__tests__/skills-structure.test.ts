import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('p-observe skills', () => {
  for (const name of ['init', 'watch', 'help']) {
    it(`${name} skill exists with name+description frontmatter`, () => {
      const p = join(PLUGIN, 'skills', name, 'SKILL.md');
      expect(existsSync(p)).toBe(true);
      const md = readFileSync(p, 'utf-8');
      expect(md).toMatch(/^---[\s\S]*\bname:\s*\S+[\s\S]*\bdescription:\s*\S+[\s\S]*---/);
    });
  }
});
