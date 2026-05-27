import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

// The canonical marker path: any drift between verification-before-completion
// and task-end will silently break the freshness check in task-end.
const MARKER_FRAGMENT = '.claude/.p-flow-state/';

describe('p-flow marker path consistency', () => {
  const verifPath = join(repoRoot(), 'plugins/p-flow/skills/verification-before-completion/SKILL.md');
  const endPath   = join(repoRoot(), 'plugins/p-flow/skills/task-end/SKILL.md');

  it('both skill files exist', () => {
    expect(existsSync(verifPath)).toBe(true);
    expect(existsSync(endPath)).toBe(true);
  });

  const verif = readFileSync(verifPath, 'utf-8');
  const end   = readFileSync(endPath,   'utf-8');

  it('verification-before-completion references the marker directory', () => {
    expect(verif).toContain(MARKER_FRAGMENT);
  });

  it('task-end references the same marker directory', () => {
    expect(end).toContain(MARKER_FRAGMENT);
  });

  it('both files agree on the <branch-safe>/last-verification suffix', () => {
    const SUFFIX = /\.claude\/\.p-flow-state\/<branch-safe>\/last-verification/;
    expect(SUFFIX.test(verif)).toBe(true);
    expect(SUFFIX.test(end)).toBe(true);
  });

  it('both files agree on the / → __ substitution rule', () => {
    const RULE = /`\/`.*`__`|`__`.*`\/`|`\/` in `<branch>` with `__`/;
    expect(RULE.test(verif)).toBe(true);
    expect(RULE.test(end)).toBe(true);
  });

  // Algorithmic equivalence: confirm the / → __ rule produces the same path
  // shape both skills document, for representative branch names.
  const branchSafe = (b: string) => b.replaceAll('/', '__');

  const cases: Array<[string, string]> = [
    ['feature/foo',         'feature__foo'],
    ['bugfix/abc/123',      'bugfix__abc__123'],
    ['main',                'main'],
    ['hotfix/CVE-2026-001', 'hotfix__CVE-2026-001'],
    ['',                    ''],
  ];

  for (const [input, expected] of cases) {
    it(`branchSafe("${input}") → "${expected}"`, () => {
      expect(branchSafe(input)).toBe(expected);
    });
  }
});
