import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

// ---------------------------------------------------------------------------
// task-brainstorming ↔ prior-art consultation invariants.
//
// Unlike the p-tasks/p-wiki/p-graph bridges, prior-art is JUDGMENT-gated, not
// marker-gated — there is no sibling plugin to detect. The properties that keep
// it safe and uncoupled:
//   1. independence — no manifest dependency; context7/deep-research optional,
//      only the built-in web tools are a hard capability;
//   2. gating       — the host skill routes through the contract, which pins
//      "opt-in / never automatic / never a precondition";
//   3. capability   — task-brainstorming actually declares the web tools so the
//      consultation can run;
//   4. output       — findings are cited and land in the ADR.
// ---------------------------------------------------------------------------

const read = (rel: string) => readFileSync(join(repoRoot(), rel), 'utf-8');

const BRIDGE_DOC = 'plugins/p-flow/skills/_shared/prior-art-bridge.md';
const HOST_SKILL = 'plugins/p-flow/skills/task-brainstorming/SKILL.md';

describe('p-flow prior-art consultation', () => {
  it('1. independence: p-flow plugin.json declares no plugin dependency', () => {
    const manifest = JSON.parse(
      read('plugins/p-flow/.claude-plugin/plugin.json'),
    ) as Record<string, unknown>;
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.requires).toBeUndefined();
    expect(manifest.extends).toBeUndefined();
  });

  it('the bridge doc exists', () => {
    expect(existsSync(join(repoRoot(), BRIDGE_DOC))).toBe(true);
  });

  it('2. the contract is judgment-gated and pins the opt-in discipline', () => {
    const doc = read(BRIDGE_DOC);
    // Judgment-gated, explicitly NOT a marker-file gate like the other bridges.
    expect(doc).toMatch(/judgment-gated/i);
    // The non-negotiable discipline that keeps it from bloating the dialog.
    expect(doc).toContain('never a precondition');
    expect(doc).toMatch(/never automatic/i);
    // Prefer delegation over reinventing research inline.
    expect(doc).toContain('context7');
    expect(doc).toContain('/deep-research');
    // The only hard capability is the built-in web tools.
    expect(doc).toContain('WebSearch');
    expect(doc).toContain('WebFetch');
  });

  it('4. output rule: findings are cited and recorded in the ADR', () => {
    const doc = read(BRIDGE_DOC);
    expect(doc).toContain('adr.md');
    expect(doc).toMatch(/source URL/i);
  });

  it('3. gate + capability: task-brainstorming routes through the contract and can run web tools', () => {
    const skill = read(HOST_SKILL);
    expect(skill).toContain('_shared/prior-art-bridge.md');
    // The web tools must be in allowed-tools or the consultation can't execute.
    const frontmatter = skill.split('---')[1] ?? '';
    expect(frontmatter).toMatch(/allowed-tools:.*\bWebSearch\b/);
    expect(frontmatter).toMatch(/allowed-tools:.*\bWebFetch\b/);
  });
});
