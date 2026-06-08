import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const read = (rel: string) => readFileSync(join(repoRoot(), rel), 'utf-8');

const INIT_SKILL = 'plugins/p-flow/skills/init/SKILL.md';
const README = 'plugins/p-flow/README.md';

// Parse a markdown table given (file content, first-row substring that identifies the table).
// Returns the array of data rows, each as an array of trimmed cell values.
const parseTable = (content: string, headerSubstring: string): string[][] => {
  const lines = content.split('\n');
  const headerIdx = lines.findIndex(
    (l) => l.trim().startsWith('|') && l.includes(headerSubstring),
  );
  if (headerIdx === -1) {
    throw new Error(`Table with header containing "${headerSubstring}" not found`);
  }
  // Header at headerIdx, separator at headerIdx+1, data rows at headerIdx+2..
  const rows: string[][] = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break;
    // Strip leading/trailing '|' and split.
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    rows.push(cells);
  }
  return rows;
};

describe('init Phase 2 — state-machine + cross-file consistency', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. Detection bash snippet must use `grep -q .`, not `head -1`.
  //    Regression guard for the bug caught in code review: `head -1` always
  //    exits 0 on empty input, so the `specs:no` branch was unreachable and
  //    every fresh repo got the "inconsistent state" refusal.
  // ─────────────────────────────────────────────────────────────────────────

  it('Step 2 specs-detection uses `grep -q .`, not `head -1`', () => {
    const content = read(INIT_SKILL);
    const bashBlockMatch = content.match(/```bash\r?\n([\s\S]+?)\r?\n```/);
    expect(bashBlockMatch, 'init/SKILL.md must contain at least one ```bash block').not.toBeNull();
    const bashBlock = bashBlockMatch![1];

    // Must include the rules probe.
    expect(bashBlock).toMatch(/test -f .+\/\.claude\/rules\/p-flow\.md/);

    // Must use grep -q . for the specs probe (the fixed form).
    expect(
      bashBlock,
      'specs probe must use `grep -q .` — `head -1` always exits 0 on empty input',
    ).toContain('grep -q .');

    // Must NOT use the broken form anywhere in the bash block.
    expect(bashBlock).not.toContain('head -1');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. State-machine table in init/SKILL.md has exactly 4 rows covering the
  //    4 cells of (rules ∈ {no, yes}) × (specs ∈ {no, yes}).
  // ─────────────────────────────────────────────────────────────────────────

  it('Step 2 state-machine table has 4 rows covering all 4 (rules, specs) cells', () => {
    const content = read(INIT_SKILL);
    const rows = parseTable(content, 'rules');
    expect(rows.length, 'state-machine must have exactly 4 data rows').toBe(4);

    const cells = new Set(rows.map((r) => `${r[0]}/${r[1]}`));
    expect(cells).toEqual(new Set(['no/no', 'yes/no', 'yes/yes', 'no/yes']));
  });

  it('Step 2 state-machine — exactly 2 of the 4 rows result in a refusal', () => {
    const content = read(INIT_SKILL);
    const rows = parseTable(content, 'rules');
    const refusals = rows.filter((r) => /\brefuse\b/i.test(r[2]));
    expect(refusals.length, 'exactly the yes/yes and no/yes rows must refuse').toBe(2);

    // The two refusing rows must be the ones with specs=yes.
    for (const row of refusals) {
      expect(row[1]).toBe('yes');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Cross-file consistency: the README Idempotency section describes the
  //    same 4 states as init/SKILL.md Step 2. If either drifts to 3 rows
  //    (which already happened once in development), fail loudly.
  // ─────────────────────────────────────────────────────────────────────────

  it('README Idempotency table matches the SKILL state-machine — 4 rows', () => {
    const readmeRows = parseTable(read(README), '`.claude/rules/p-flow.md`');
    expect(
      readmeRows.length,
      'README Idempotency table must have 4 rows to match SKILL.md state-machine',
    ).toBe(4);

    // Normalise README's wording {missing, present} × {none, ≥ 1} into the
    // SKILL's {no, yes} × {no, yes} convention and assert set equality.
    const norm = (s: string): string => {
      if (s === 'missing' || s === 'none') return 'no';
      if (s === 'present' || /≥\s*1/.test(s)) return 'yes';
      // Allow the SKILL convention as-is too in case the README ever switches.
      if (s === 'no' || s === 'yes') return s;
      throw new Error(`Unrecognised cell value in README Idempotency table: "${s}"`);
    };

    const readmeCells = new Set(
      readmeRows.map((r) => `${norm(r[0])}/${norm(r[1])}`),
    );
    expect(readmeCells).toEqual(new Set(['no/no', 'yes/no', 'yes/yes', 'no/yes']));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Step 9 must enumerate exactly the placeholders the brainstorm fills,
  //    so that drift in placeholder names between the template and the skill
  //    is caught early. (We don't assert that EVERY template placeholder is
  //    listed — Step 9 deliberately leaves some literal for task-brainstorming
  //    refine-mode. We only assert that the ones Step 9 names actually exist
  //    in the template.)
  // ─────────────────────────────────────────────────────────────────────────

  it('Step 9 placeholder names all exist in specification.template.md', () => {
    const skill = read(INIT_SKILL);
    const template = read('plugins/p-flow/skills/_shared/templates/specification.template.md');

    // Extract the placeholder list — the bulleted enumeration that runs from
    // `### Step 9` until the catch-all `**Every other**` clause (which uses
    // `{{PLACEHOLDER}}` as a meta-reference, not a real template token).
    const step9Match = skill.match(/### Step 9[\s\S]+?(?=\*\*Every other )/);
    expect(step9Match, 'Step 9 enumeration section not found').not.toBeNull();
    const step9List = step9Match![0];

    const tokens = Array.from(step9List.matchAll(/`\{\{([A-Z_]+)\}\}`/g)).map((m) => m[1]);
    // Step 9 currently lists 9 placeholders — guard against silent shrinkage/expansion.
    expect(tokens.length).toBeGreaterThanOrEqual(9);

    for (const token of tokens) {
      expect(
        template,
        `Step 9 names {{${token}}} but the template doesn't contain it`,
      ).toContain(`{{${token}}}`);
    }
  });
});
