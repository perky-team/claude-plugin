import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

// Defends the spec-audit subagent wiring in task-brainstorming:
// - the colocated read-write auditor template ships and declares its non-scope
// - task-brainstorming dispatches it via the colocated-template convention
// - the 3-pass cap and Blockers-drive-the-loop rule are documented (not silently
//   droppable), and `Task` is declared in allowed-tools.
const skillDir = join(repoRoot(), 'plugins/p-flow/skills/task-brainstorming');
const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');

describe('p-flow spec audit subagent', () => {
  it('ships the spec-auditor template alongside task-brainstorming', () => {
    expect(existsSync(join(skillDir, 'spec-auditor.md'))).toBe(true);
  });

  it('spec-auditor declares its non-scope (code/plans out)', () => {
    const t = readFileSync(join(skillDir, 'spec-auditor.md'), 'utf-8');
    expect(t).toContain('## What is NOT your scope');
  });

  it('task-brainstorming dispatches the auditor via the colocated template', () => {
    expect(skill).toContain('${CLAUDE_SKILL_DIR}/spec-auditor.md');
  });

  it('task-brainstorming declares Task in allowed-tools', () => {
    const fm = skill.split('---')[1] ?? '';
    expect(fm).toMatch(/allowed-tools:.*\bTask\b/);
  });

  it('§5 documents the 3-pass cap and the Blockers-drive-the-loop rule', () => {
    expect(skill).toMatch(/3 passes/);
    expect(skill).toMatch(/Only Blockers drive the loop/i);
  });
});
