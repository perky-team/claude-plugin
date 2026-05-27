import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const read = (rel: string) => readFileSync(join(repoRoot(), rel), 'utf-8');

// ----------------------------------------------------------------------------
// Plan.md canonical section names — per-file expected sets.
// Different skills reference different subsets of the canonical sections;
// each pair below is a contract. Drift in spelling or removal of an expected
// heading from the named file → test failure.

const PLAN_SECTION_CONTRACTS: Record<string, string[]> = {
  // writing-plan WRITES the initial template; references only the sections
  // it actually emits. `## Review follow-ups` / `## Review decisions (audit)`
  // are created lazily by the review skills, not by writing-plan.
  'plugins/p-flow/skills/writing-plan/SKILL.md': [
    '## Steps',
    '## Open questions',
    '## Risks',
  ],
  // Review skills append follow-ups and audit bullets, anchored relative to
  // `## Steps` and `## Open questions`.
  'plugins/p-flow/skills/requesting-code-review/SKILL.md': [
    '## Steps',
    '## Review follow-ups',
    '## Review decisions (audit)',
    '## Open questions',
  ],
  // requesting-task-review defers anchor-handling ("Same as `requesting-code-
  // review` §6") to its sibling, so it only directly writes to two sections.
  'plugins/p-flow/skills/requesting-task-review/SKILL.md': [
    '## Review follow-ups',
    '## Review decisions (audit)',
  ],
  // task-end counts (Steps + Review follow-ups) and excludes (Open questions
  // + Risks + Review decisions). Mentions all five.
  'plugins/p-flow/skills/task-end/SKILL.md': [
    '## Steps',
    '## Review follow-ups',
    '## Review decisions (audit)',
    '## Open questions',
    '## Risks',
  ],
};

describe('p-flow plan.md section names consistency', () => {
  for (const [file, headings] of Object.entries(PLAN_SECTION_CONTRACTS)) {
    describe(file, () => {
      const content = read(file);
      for (const heading of headings) {
        it(`contains canonical heading "${heading}"`, () => {
          expect(content).toContain(heading);
        });
      }
    });
  }
});

// ----------------------------------------------------------------------------
// Branch type list — task-start declares the 5 types; task-end's slug
// resolution must accept all 5. Currently maintained in two places by hand.

const BRANCH_TYPES = ['feature', 'bugfix', 'hotfix', 'chore', 'docs'];

describe('p-flow branch type list consistency', () => {
  const taskStart = read('plugins/p-flow/skills/task-start/SKILL.md');
  const taskEnd   = read('plugins/p-flow/skills/task-end/SKILL.md');

  for (const t of BRANCH_TYPES) {
    it(`task-start mentions branch type "${t}"`, () => {
      expect(taskStart).toMatch(new RegExp(`\\b${t}\\b`));
    });
    it(`task-end mentions branch type "${t}"`, () => {
      expect(taskEnd).toMatch(new RegExp(`\\b${t}\\b`));
    });
  }
});
