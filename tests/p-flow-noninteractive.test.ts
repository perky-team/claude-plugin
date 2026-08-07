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
//   4. the non-interactive path resolves the parent p-tasks task from its
//      ARGUMENT (or a single `in_progress` task), never from the branch name.
//      The headless deployment is a p-shed loop: it lives on ONE long-lived
//      branch (`auto/dev`) and takes whichever task `p-tasks:next` hands it, so
//      a branch-derived slug matches no task and the run stopped every time.
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
const NI_PRECONDITION_HEADING = '### Non-interactive — precondition 3 only';

/**
 * The verbatim interactive precondition-3 slug rule. The branch IS the right
 * source with a human at the keyboard (one branch per task, `<type>/<slug>`);
 * drift here is the regression.
 */
const INTERACTIVE_SLUG_RULE =
  'Determine `<slug>` from the current branch name (strip the `<type>/` prefix) or ask the user.';

/** The exact argument form a caller writes into a headless prompt by hand. */
const TASK_ARG = '--task <t-id|task-title>';

/** The two stop reasons must name WHICH input was missing — the operator's fix differs. */
const STOP_NONE = 'no `--task` argument was given and no task is `in_progress`';
const STOP_MANY = 'no `--task` argument was given and <N> tasks are `in_progress`';

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

  it('13. the non-interactive precondition never derives the task from the branch', () => {
    const ni = section(read(SKILL), NI_PRECONDITION_HEADING);
    expect(ni, 'headless must not read the branch name').not.toContain(
      'git rev-parse --abbrev-ref HEAD',
    );
    expect(ni).not.toMatch(/strip the `<type>\/` prefix/);
    expect(ni).toMatch(/never from the branch name/i);
    // …and it still asks nobody anything.
    expect(ni.toLowerCase()).not.toContain('ask the user');
    // The stale branch-derived failure reason is gone with it.
    expect(read(SKILL)).not.toMatch(/has no matching p-tasks task/);
  });

  it('14. the INTERACTIVE precondition still resolves the slug from the branch, verbatim', () => {
    expect(read(SKILL)).toContain(INTERACTIVE_SLUG_RULE);
  });

  it('15. the skill argument is documented with its exact form, as the intended path', () => {
    const ni = section(read(SKILL), NI_PRECONDITION_HEADING);
    // A caller writes this into a prompt by hand — the exact form is pinned.
    expect(ni).toContain(TASK_ARG);
    expect(ni).toMatch(/intended path/i);
    // Both accepted values are spelled out: a p-tasks id, or the exact title.
    expect(ni).toMatch(/task id/i);
    expect(ni).toMatch(/exact title/i);
  });

  it('16. the `in_progress` fallback is qualified by "exactly one" and ranks below the argument', () => {
    const ni = section(read(SKILL), NI_PRECONDITION_HEADING);
    expect(ni).toMatch(/only when there is \*\*exactly one\*\*/i);
    expect(ni).toContain('in_progress');
    // Order matters: the caller's argument wins over the inferred fallback.
    expect(ni.indexOf('--task')).toBeLessThan(ni.indexOf('in_progress'));
    // Two or more is ambiguous — measured: one live deployment has 3.
    expect(ni).toMatch(/must not be guessed/i);
  });

  it('17. the failure reasons are distinct and name which input was missing', () => {
    const ni = section(read(SKILL), NI_PRECONDITION_HEADING);
    expect(ni).toContain(STOP_NONE);
    expect(ni).toContain(STOP_MANY);
    // An explicit argument that matches nothing is its own reason, and must not
    // silently fall through to the fallback — that would review the wrong task.
    expect(ni).toMatch(/matches no p-tasks task/);
    expect(ni).toMatch(/never falls through/i);
    // Three distinct stops, not one reason reused.
    const stops = ni.split('cannot resolve the parent task').length - 1;
    expect(stops, 'each stop states its own named reason').toBeGreaterThanOrEqual(3);
  });
});
