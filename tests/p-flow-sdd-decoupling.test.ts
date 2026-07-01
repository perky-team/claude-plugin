import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

// ---------------------------------------------------------------------------
// subagent-driven-development — structure + decoupling invariants.
//
// The skill is an ISOLATED execution mode (fresh subagent per step) that must:
//   1. ship its three files (SKILL + two inline prompt templates);
//   2. stay decoupled from any external plugin — no `superpowers` string, no
//      `.superpowers/` path (the whole point of shipping our own);
//   3. dispatch via `Task` + `general-purpose` inline templates, NOT registered
//      subagents;
//   4. route its progress ledger through the p-tasks gate (no second store);
//   5. reuse the canonical code-review template for the final broad review.
// ---------------------------------------------------------------------------

const SKILL_DIR = 'plugins/p-flow/skills/subagent-driven-development';
const SKILL = `${SKILL_DIR}/SKILL.md`;
const IMPLEMENTER = `${SKILL_DIR}/implementer-prompt.md`;
const REVIEWER = `${SKILL_DIR}/task-reviewer-prompt.md`;

const read = (rel: string) => readFileSync(join(repoRoot(), rel), 'utf-8');

describe('subagent-driven-development', () => {
  it('1. ships SKILL.md and both inline prompt templates', () => {
    for (const rel of [SKILL, IMPLEMENTER, REVIEWER]) {
      expect(existsSync(join(repoRoot(), rel)), `${rel} must exist`).toBe(true);
    }
  });

  it('2. decoupled: no `superpowers` string and no `.superpowers/` path in any file', () => {
    for (const rel of [SKILL, IMPLEMENTER, REVIEWER]) {
      const text = read(rel).toLowerCase();
      expect(text, `${rel} must not mention superpowers`).not.toContain('superpowers');
    }
    // Handoff workspace is our own namespace, never the reference plugin's.
    for (const rel of [SKILL, IMPLEMENTER, REVIEWER]) {
      expect(read(rel), `${rel} must use .p-flow/ not .superpowers/`).not.toContain('.superpowers/');
    }
    expect(read(SKILL)).toContain('.p-flow/sdd/');
  });

  it('3. dispatches via Task + general-purpose inline templates, not registered subagents', () => {
    const skill = read(SKILL);
    expect(skill).toContain('general-purpose');
    // frontmatter must grant the Task tool
    expect(skill).toMatch(/allowed-tools:.*\bTask\b/);
    // must NOT resolve a registered subagent by name
    expect(skill).not.toMatch(/subagent_type:\s*(code-reviewer|task-reviewer|implementer)\b/);
    // both templates are the dispatch payloads, read from the skill dir
    expect(skill).toContain('${CLAUDE_SKILL_DIR}/implementer-prompt.md');
    expect(skill).toContain('${CLAUDE_SKILL_DIR}/task-reviewer-prompt.md');
  });

  it('4. gate: the progress ledger routes through the p-tasks bridge (no second store)', () => {
    expect(read(SKILL)).toContain('_shared/ptasks-bridge.md');
  });

  it('5. reuses the canonical code-reviewer template for the final broad review', () => {
    expect(read(SKILL)).toContain('../requesting-code-review/code-reviewer.md');
  });

  it('the per-step reviewer template keeps a scope-discipline section', () => {
    expect(read(REVIEWER)).toContain('## What is NOT your scope');
  });

  // Reachability: SDD lives in its own dir, but two OTHER files decide whether
  // it is ever reached. If either silently drops the skill it becomes an
  // orphan that README/tests still list but the flow never routes to.
  it('writing-plan hands off to both execution modes (SDD stays reachable)', () => {
    const wp = read('plugins/p-flow/skills/writing-plan/SKILL.md');
    expect(wp, 'writing-plan must offer the inline mode').toContain('executing-plan');
    expect(wp, 'writing-plan must offer the isolated mode').toContain('subagent-driven-development');
  });

  it('using-p-flow discovery surface lists the skill (else the SessionStart hook hides it)', () => {
    expect(read('plugins/p-flow/skills/using-p-flow/SKILL.md')).toContain('subagent-driven-development');
  });
});
