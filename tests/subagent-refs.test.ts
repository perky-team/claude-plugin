import { describe, expect, it } from 'vitest';
import { findAgents, findPlugins, findSkills } from './helpers.js';

// Matches `subagent_type: <name>` references inside SKILL.md prose.
// The name is kebab-case (lowercase, digits, hyphens) — same constraint
// as the Claude Code plugin name spec. We capture the first such token
// after the literal `subagent_type:` (with optional surrounding backticks).
const SUBAGENT_REF = /subagent_type:\s*`?([a-z][a-z0-9-]*)`?/g;

describe('subagent references', () => {
  const plugins = findPlugins();

  for (const plugin of plugins) {
    const skills = findSkills(plugin.dir);
    const agents = findAgents(plugin.dir);

    // Collect every `subagent_type:` reference across this plugin's skills.
    const refs: { skill: string; agentName: string }[] = [];
    for (const skill of skills) {
      for (const match of skill.raw.matchAll(SUBAGENT_REF)) {
        refs.push({ skill: skill.name, agentName: match[1] });
      }
    }

    // Skip plugins where no skill references any subagent — nothing to verify.
    if (refs.length === 0) continue;

    const agentNames = new Set(agents.map((a) => a.frontmatter.name as string));

    describe(`plugin: ${plugin.name}`, () => {
      for (const { skill, agentName } of refs) {
        it(`skill "${skill}" references agent "${agentName}" which exists in this plugin`, () => {
          expect(
            agentNames.has(agentName),
            `skill "${skill}" mentions subagent_type "${agentName}" but no agents/<name>.md with that frontmatter name was found in plugin "${plugin.name}" (have: ${[...agentNames].join(', ') || 'none'})`,
          ).toBe(true);
        });
      }
    });
  }
});
