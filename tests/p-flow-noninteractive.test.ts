import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

// ---------------------------------------------------------------------------
// p-flow non-interactive mode invariants.
//
// `P_FLOW_NONINTERACTIVE=1` lets a skill run inside a headless `claude -p` job
// (a p-shed worker, a CI step) where nobody can answer a question. The value of
// the feature depends entirely on three properties, and each is asserted here:
//   1. the gate exists and is shared — one doc, one env var, one rule;
//   2. the interactive path is UNTOUCHED — the human still gets every question,
//      in the same words (the byte-for-byte rule the ptasks bridge established);
//   3. the non-interactive path asks NOTHING and cannot `reject` — dropping a
//      finding is a judgement reserved for a human, so the policy may only
//      accept or defer.
// Modelled on tests/p-flow-ptasks-bridge.test.ts.
// ---------------------------------------------------------------------------

const read = (rel: string) => readFileSync(join(repoRoot(), rel), 'utf-8');

const GATE_DOC = 'plugins/p-flow/skills/_shared/noninteractive.md';
const SKILL = 'plugins/p-flow/skills/requesting-code-review/SKILL.md';
const ENV_VAR = 'P_FLOW_NONINTERACTIVE';
const PTASKS_MARKER = 'docs/tasks/.ptasks.json';

/** The verbatim interactive Blocker question. Drift here is the regression. */
const BLOCKER_QUESTION =
  '**Blockers**: one at a time. For each, ask the user with three options: `fix` / `defer` / `reject`.';
const NO_DEFAULTS = 'No defaults — user must answer.';

const NI_TRIAGE_HEADING = '#### Non-interactive triage policy';

/** Slice a markdown section: from `heading` up to the next heading of any level. */
const section = (text: string, heading: string): string => {
  const start = text.indexOf(heading);
  expect(start, `${heading} must exist`).toBeGreaterThan(-1);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n#{1,6} /);
  return next === -1 ? rest : rest.slice(0, next);
};

describe('p-flow non-interactive mode', () => {
  it('1. the shared gate doc exists and pins the env var + its strict value', () => {
    expect(existsSync(join(repoRoot(), GATE_DOC)), `${GATE_DOC} must exist`).toBe(true);
    const doc = read(GATE_DOC);
    expect(doc).toContain(ENV_VAR);
    // Only the exact string `1` enables it; a typo must degrade to asking a human.
    expect(doc).toContain('test "${P_FLOW_NONINTERACTIVE:-}" = "1"');
  });

  it('2. the gate doc keeps "anything else → interactive, silent, byte-for-byte unchanged"', () => {
    const doc = read(GATE_DOC);
    expect(doc).toMatch(/silent no-op/i);
    expect(doc).toMatch(/byte-for-byte unchanged/i);
  });

  it('3. the gate doc states the rule: never ask — documented default, or a named failure', () => {
    const doc = read(GATE_DOC);
    expect(doc).toMatch(/never asks/i);
    expect(doc).toMatch(/documented default/i);
    expect(doc).toMatch(/named reason/i);
    // The hard boundary: a question that is the user's to decide is never answered for them.
    expect(doc).toMatch(/never invent an answer on the user's behalf/i);
    // Same-shape audit trail — a policy decision is recorded like a human decision.
    expect(doc).toMatch(/same shape in both modes/i);
  });

  it('4. gate: requesting-code-review routes through the shared doc', () => {
    expect(read(SKILL)).toContain('_shared/noninteractive.md');
  });

  it('5. the interactive path still puts the three-option Blocker question, verbatim', () => {
    const skill = read(SKILL);
    expect(skill).toContain(BLOCKER_QUESTION);
    expect(skill).toContain(NO_DEFAULTS);
    // …and the batch Suggestions question is still there too.
    expect(skill).toContain('Reply with comma-separated indices to fix');
  });

  it('6. the non-interactive triage path contains no question at all', () => {
    const ni = section(read(SKILL), NI_TRIAGE_HEADING);
    expect(ni, 'the non-interactive policy must not contain a question mark').not.toContain('?');
    expect(ni.toLowerCase()).not.toContain('ask the user');
    expect(ni.toLowerCase()).not.toContain('askuserquestion');
    // The interactive question must not have leaked into the policy block.
    expect(ni).not.toContain(BLOCKER_QUESTION);
  });

  it('7. the non-interactive triage path makes `reject` unavailable', () => {
    const ni = section(read(SKILL), NI_TRIAGE_HEADING);
    expect(ni).toMatch(/`reject` is \*\*unavailable\*\*/);
    expect(ni).toMatch(/reserved for a human/i);
    // The two documented decisions, and only those two.
    expect(ni).toMatch(/\| Blocker \| `fix`/);
    expect(ni).toMatch(/\| Suggestion \| `fix`/);
    expect(ni).toMatch(/\| Nit \| `defer`/);
  });

  it('8. the non-interactive path records through the same §5 calls (same audit shape)', () => {
    const ni = section(read(SKILL), NI_TRIAGE_HEADING);
    expect(ni).toMatch(/§5/);
    expect(ni).toMatch(/canonical mode/i);
    expect(ni).toContain('--resolution');
  });

  it('9. non-interactive requires canonical mode — p-tasks absent fails with a named reason', () => {
    const skill = read(SKILL);
    // The failure names the marker file, so the job log says WHY it stopped.
    expect(skill).toContain(PTASKS_MARKER);
    expect(skill).toMatch(/non-interactive mode requires p-tasks/i);
    // No silent legacy fallback.
    expect(skill).toMatch(/Do not fall back to legacy/i);
    // A slug is never guessed.
    expect(skill).toMatch(/Never guess a slug/i);
    // Jira writes need a human yes the headless run cannot obtain.
    expect(skill).toMatch(/cannot confirm Jira writes/i);
  });

  it('10. allowed-tools covers the new path (env probe + p-tasks dispatch)', () => {
    const fm = read(SKILL).split('---')[1] ?? '';
    const allowed = /allowed-tools:(.*)/.exec(fm)?.[1] ?? '';
    expect(allowed).toContain('Bash(test:*)'); // the gate probe
    expect(allowed).toContain('Skill'); // p-tasks:add / p-tasks:list dispatch
    expect(allowed).toContain('Task'); // unchanged: reviewer dispatch
  });

  it('11. decoupling: the gate introduces no plugin dependency and no p-tasks CLI call', () => {
    const manifest = JSON.parse(
      read('plugins/p-flow/.claude-plugin/plugin.json'),
    ) as Record<string, unknown>;
    expect(manifest.dependencies).toBeUndefined();
    expect(read(GATE_DOC)).not.toContain('ptasks.mjs');
    expect(read(SKILL)).not.toContain('ptasks.mjs');
  });

  it('12. code-reviewer.md stays mode-neutral (shared with subagent-driven-development)', () => {
    const template = read('plugins/p-flow/skills/requesting-code-review/code-reviewer.md');
    expect(template).not.toContain(ENV_VAR);
    expect(template.toLowerCase()).not.toContain('non-interactive');
  });
});
