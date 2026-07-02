import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

// ---------------------------------------------------------------------------
// Canonical-mode status LIFECYCLE invariants (todo → in_progress → done).
//
// Before this change the execution skills only flipped a sub-task todo → done,
// so (1) the tracker never showed what was CURRENTLY being worked and (2) an
// interrupted run left the item `todo` — indistinguishable from "never started".
//
// These tests pin the three-state lifecycle into the docs that must teach it:
//   - the shared bridge is the canonical reference (meanings + transitions +
//     interrupt-recovery rule; legacy plan.md is binary and unchanged);
//   - executing-plan / subagent-driven-development set in_progress at step
//     start, parent on first step, done only on green, and DISTINGUISH todo
//     vs in_progress on resume;
//   - receiving-code-review sets a follow-up in_progress when work begins.
//
// This is CANONICAL mode only — legacy plan.md checkboxes stay binary. The
// legacy-unchanged guarantee is asserted structurally (no in_progress leaks
// into a plan.md checkbox instruction).
// ---------------------------------------------------------------------------

const read = (rel: string) => readFileSync(join(repoRoot(), rel), 'utf-8');

const BRIDGE = 'plugins/p-flow/skills/_shared/ptasks-bridge.md';
const EXEC = 'plugins/p-flow/skills/executing-plan/SKILL.md';
const SDD = 'plugins/p-flow/skills/subagent-driven-development/SKILL.md';
const RECV = 'plugins/p-flow/skills/receiving-code-review/SKILL.md';
const USING = 'plugins/p-flow/skills/using-p-flow/SKILL.md';
const README = 'plugins/p-flow/README.md';

describe('canonical status lifecycle — shared bridge (the reference)', () => {
  const doc = read(BRIDGE);

  it('documents a dedicated status-lifecycle section', () => {
    expect(doc).toMatch(/##\s+Status lifecycle/i);
  });

  it('defines all three states and their meanings', () => {
    // todo = not started, in_progress = started/interrupted, done = verified.
    expect(doc).toContain('in_progress');
    expect(doc).toMatch(/todo\b.*not started|not started.*\btodo/i);
    expect(doc).toMatch(/done\b.*(verified|complete)/i);
  });

  it('gives the exact transition commands (in_progress at start, done on green)', () => {
    expect(doc).toContain('--status in_progress');
    expect(doc).toContain('--status done');
  });

  it('sets the PARENT in_progress when the first sub-task starts', () => {
    expect(doc).toMatch(/parent[\s\S]{0,120}in_progress[\s\S]{0,120}first/i);
  });

  it('pins the interrupt-recovery rule: in_progress on resume = interrupted → reconcile', () => {
    expect(doc).toMatch(/interrupt/i);
    expect(doc).toMatch(/reconcile/i);
    // must forbid both wrong reactions: treating it as done, and blind re-run
    expect(doc).toMatch(/not.*(assume|treat).*done|do NOT treat it as done/i);
    expect(doc).toMatch(/re-?run|redo/i);
  });

  it('notes legacy plan.md is binary and unchanged (why canonical is preferable)', () => {
    expect(doc).toMatch(/binary/i);
    expect(doc).toMatch(/plan\.md/i);
  });
});

describe('canonical status lifecycle — executing-plan', () => {
  const doc = read(EXEC);

  it('sets the sub-task in_progress at step start (before implementing)', () => {
    expect(doc).toContain('--status in_progress');
    expect(doc).toMatch(/in_progress[\s\S]{0,200}(before|begin|start|implement)/i);
  });

  it('sets the parent in_progress on the first step', () => {
    expect(doc).toMatch(/parent[\s\S]{0,160}in_progress/i);
  });

  it('still marks done only on green', () => {
    expect(doc).toContain('--status done');
  });

  it('resume wording distinguishes todo (untouched) from in_progress (interrupted)', () => {
    expect(doc).toMatch(/in_progress/);
    expect(doc).toMatch(/interrupt/i);
    expect(doc).toMatch(/reconcile/i);
  });
});

describe('canonical status lifecycle — subagent-driven-development', () => {
  const doc = read(SDD);

  it('sets the sub-task in_progress BEFORE dispatching the implementer', () => {
    expect(doc).toContain('--status in_progress');
    expect(doc).toMatch(/in_progress[\s\S]{0,200}dispatch|dispatch[\s\S]{0,200}in_progress/i);
  });

  it('sets the parent in_progress on the first step', () => {
    expect(doc).toMatch(/parent[\s\S]{0,160}in_progress/i);
  });

  it('marks done only after the per-step review passes', () => {
    expect(doc).toContain('--status done');
  });

  it('progress-ledger section teaches three-state resume semantics', () => {
    expect(doc).toMatch(/ledger/i);
    expect(doc).toMatch(/in_progress/);
    expect(doc).toMatch(/interrupt/i);
    expect(doc).toMatch(/reconcile/i);
  });
});

describe('canonical status lifecycle — receiving-code-review', () => {
  const doc = read(RECV);

  it('sets the follow-up sub-task in_progress when work on it begins', () => {
    expect(doc).toContain('--status in_progress');
  });

  it('still closes with --status done (and --resolution for reject/defer)', () => {
    expect(doc).toContain('--status done');
    expect(doc).toContain('--resolution');
  });
});

describe('canonical status lifecycle — discovery surfaces', () => {
  it('using-p-flow describes the three-state canonical lifecycle', () => {
    expect(read(USING)).toContain('in_progress');
  });

  it('README describes the three-state canonical lifecycle', () => {
    expect(read(README)).toContain('in_progress');
  });
});

describe('legacy plan.md stays binary (no in_progress leak into checkbox flow)', () => {
  // A checkbox is `- [ ]` / `- [x]` only. Guard that the actual transition
  // COMMAND `--status in_progress` is never coupled to a plan.md checkbox glyph
  // on the same line — the three-state lifecycle is p-tasks (canonical) only.
  // (Prose that merely CONTRASTS the two modes may name both; only the command
  // tied to a checkbox would be a real legacy-behaviour change.)
  for (const rel of [EXEC, SDD, RECV]) {
    it(`${rel} never couples the in_progress command to a plan.md checkbox`, () => {
      const lines = read(rel).split('\n');
      for (const line of lines) {
        if (line.includes('--status in_progress')) {
          expect(line, `the in_progress command must not touch a checkbox on: ${line}`)
            .not.toMatch(/- \[[ x]\]/);
        }
      }
    });
  }
});
