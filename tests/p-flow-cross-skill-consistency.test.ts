import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, findSkills } from './helpers.js';

const read = (rel: string) => readFileSync(join(repoRoot(), rel), 'utf-8');

// ----------------------------------------------------------------------------
// Plan.md canonical section names — per-file expected sets.
// Different skills reference different subsets of the canonical sections;
// each pair below is a contract. Drift in spelling or removal of an expected
// heading from the named file → test failure.

const PLAN_SECTION_CONTRACTS: Record<string, string[]> = {
  // Post-Wave-C: writing-plan no longer inlines a template; it delegates to
  // `_shared/templates/plan-{generic,tdd}.template.md`. Those files emit
  // the canonical section headings; writing-plan only references them by
  // path. The two template files are now the source of truth for plan
  // section names.
  'plugins/p-flow/skills/_shared/templates/plan-generic.template.md': [
    '## Steps',
    '## Open questions',
    '## Risks',
  ],
  'plugins/p-flow/skills/_shared/templates/plan-tdd.template.md': [
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

// ----------------------------------------------------------------------------
// task-start invocation form — the command's only argument is a bare <slug>;
// the branch type is asked interactively. User-facing surfaces (skills + README)
// must NOT instruct `/p-flow:task-start <type>/<slug>` (or a literal type prefix
// like `feature/<slug>`), which task-start would swallow whole into the slug and
// produce a doubled-type branch `feature/feature/<slug>`.

const BAD_INVOCATION = new RegExp(
  `task-start\\s+(?:<type>/|${BRANCH_TYPES.join('/|')}/)`,
);

describe('p-flow task-start invocation form consistency', () => {
  const surfaces: Array<{ label: string; text: string }> = [
    ...findSkills(join(repoRoot(), 'plugins', 'p-flow')).map((s) => ({
      label: `skills/${s.name}/SKILL.md`,
      text: s.raw,
    })),
    { label: 'README.md', text: read('plugins/p-flow/README.md') },
  ];

  for (const { label, text } of surfaces) {
    it(`${label} invokes task-start with a bare <slug> (no <type>/ prefix)`, () => {
      const match = text.match(BAD_INVOCATION);
      expect(match, match ? `found "${match[0]}"` : undefined).toBeNull();
    });
  }
});
